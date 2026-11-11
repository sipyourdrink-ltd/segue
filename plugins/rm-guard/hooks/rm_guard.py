#!/usr/bin/env python3
"""PreToolUse hook for Claude Code: deny a Bash command that runs rm with both
recursive and force flags.

The command is read as text. It is never expanded and never run. A command
that does not contain the letters "rm" is always allowed.
"""
import json
import re
import sys

DYN = ""  # stands for an expansion whose value the guard cannot read
MAX_DEPTH = 20
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish"}
SKIP = {"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "!", "coproc"}
INERT = {"for", "case", "select", "function", "esac"}
# wrapper program -> its one-letter options that take a separate value
WRAPPERS = {
    "sudo": "ugpCDRTUrth", "doas": "uC", "env": "uC", "nice": "n", "ionice": "cnp",
    "timeout": "ks", "xargs": "IELnPsda", "stdbuf": "ioe", "time": "fo", "exec": "a",
    "caffeinate": "tw", "command": "", "builtin": "", "nohup": "", "setsid": "",
}
ASSIGN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=")
VARIABLE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])")
DELIMITER = re.compile(r"'([^'\n]*)'|\"([^\"\n]*)\"|(\\?[^\s;|&<>()`'\"]+)")
ROUGH = re.compile(r"(?:^|[\s;&|(`'\"/\\])rm\s+([^;&|\n]*)")
REASON = ("rm with recursive and force flags is blocked by the rm-guard plugin. "
          "Remove the named files one by one, or ask the user to run the command.")
REASON_UNPARSED = ("The command could not be parsed and appears to run rm with recursive "
                   "and force flags; it is blocked by the rm-guard plugin.")


class Unparsed(Exception):
    """The text is not shell syntax this guard can split into commands."""


def base(word):
    return word.rsplit("/", 1)[-1]


def rm_recursive_force(args):
    recursive = force = False
    for arg in args:
        if arg == "--":
            break
        if not arg.startswith("-") or arg == "-":
            continue
        if DYN in arg or "{" in arg:
            return True  # flags hidden in an expansion: treated as both
        if arg.startswith("--"):
            recursive |= len(arg) > 2 and "--recursive".startswith(arg)
            force |= len(arg) > 2 and "--force".startswith(arg)
        else:
            recursive |= "r" in arg or "R" in arg
            force |= "f" in arg
    return recursive and force


def unwrap(words):
    """Drop reserved words, assignments and wrapper programs in front of the real program."""
    words = list(words)
    while words:
        if words[0] in SKIP or ASSIGN.match(words[0]):
            words.pop(0)
            continue
        name = base(words[0])
        if name not in WRAPPERS:
            break
        words.pop(0)
        duration_seen = False
        while words:
            arg = words[0]
            if arg == "--":
                words.pop(0)
                break
            if arg.startswith("-") and len(arg) > 1:
                words.pop(0)
                if len(arg) == 2 and arg[1] in WRAPPERS[name] and words:
                    words.pop(0)
            elif ASSIGN.match(arg):
                words.pop(0)
            elif name == "timeout" and not duration_seen:
                words.pop(0)
                duration_seen = True
            else:
                break
    return words


def inline_script(args):
    """The script given to a shell or to su with -c, or None."""
    for index, arg in enumerate(args[:-1]):
        if arg == "--command" or (arg.startswith("-") and not arg.startswith("--") and "c" in arg):
            return args[index + 1]
    return None


def reads_script_from_stdin(words):
    words = unwrap(words)
    if not words:
        return False
    name = base(words[0])
    return name == "ssh" or (name in SHELLS and inline_script(words[1:]) is None)


def dangerous(words, depth):
    words = unwrap(words)
    if not words or words[0] in INERT:
        return False
    name, args = base(words[0]), words[1:]
    if name == "rm":
        return rm_recursive_force(args)
    if name in SHELLS or name == "su":
        script = inline_script(args)
        return script is not None and script_dangerous(script, depth + 1)
    if name == "eval":
        return script_dangerous(" ".join(args), depth + 1)
    if name == "trap":
        return bool(args) and not args[0].startswith("-") and script_dangerous(args[0], depth + 1)
    if name == "find":
        for index, arg in enumerate(args):
            if arg in ("-exec", "-execdir", "-ok", "-okdir"):
                inner = []
                for word in args[index + 1:]:
                    if word in (";", "+"):
                        break
                    inner.append(word)
                if dangerous(inner, depth + 1):
                    return True
        return False
    if name == "ssh":
        return any((" " in arg and script_dangerous(arg, depth + 1))
                   or (base(arg) == "rm" and dangerous(args[index:], depth + 1))
                   for index, arg in enumerate(args))
    return False


def script_dangerous(text, depth=0):
    commands = []
    parse(text, 0, None, commands, depth)
    return any(dangerous(words, depth) for words in commands)


def substitutions(text, out, depth):
    """Parse the command substitutions inside text that is otherwise data."""
    index = 0
    while index < len(text):
        if text[index] == "\\":
            index += 2
        elif text[index] == "`":
            index = parse(text, index + 1, "`", out, depth)
        elif text.startswith("$(", index):
            index = parse(text, index + 2, ")", out, depth)
        else:
            index += 1


def dollar(text, index, out, depth):
    """Consume one $-expansion. Returns (next index, text to add to the word)."""
    if text.startswith("$(", index):
        return parse(text, index + 2, ")", out, depth + 1), DYN
    if text.startswith("${", index):
        end, level = index + 2, 1
        while end < len(text) and level:
            level += {"{": 1, "}": -1}.get(text[end], 0)
            end += 1
        if level:
            raise Unparsed
        substitutions(text[index + 2:end - 1], out, depth + 1)
        return end, DYN
    match = VARIABLE.match(text, index)
    if match:
        return match.end(), DYN
    return index + 1, "$"


def heredoc_body(text, start, delimiter, strip_tabs, closer):
    """Returns (body, index after the terminator) or None when there is no terminator."""
    line_start = start
    while line_start <= len(text):
        line_end = text.find("\n", line_start)
        line = text[line_start:] if line_end < 0 else text[line_start:line_end]
        if strip_tabs:
            line = line.lstrip("\t")
        if line == delimiter:
            return text[start:line_start], (len(text) if line_end < 0 else line_end + 1)
        if closer == ")" and line.startswith(delimiter) and line[len(delimiter):].strip() == ")":
            return text[start:line_start], line_start + text[line_start:].index(")")
        if line_end < 0:
            return None
        line_start = line_end + 1
    return None


def parse(text, index, closer, out, depth):
    """Split text from index into simple commands (lists of words) appended to out.

    Stops after closer, when given. Scripts nested in substitutions, subshells and
    here-documents fed to a shell are parsed into out as well.
    """
    if depth > MAX_DEPTH:
        raise Unparsed
    size = len(text)
    words, word, pending = [], None, []

    def end_command():
        nonlocal words, word
        if word is not None:
            words.append(word)
            word = None
        if words:
            out.append(words)
            words = []

    while index < size:
        char = text[index]
        if char == closer:
            end_command()
            return index + 1
        if char == "\\":
            if text[index + 1:index + 2] != "\n":
                word = (word or "") + text[index + 1:index + 2]
            index += 2
        elif char == "'":
            end = text.find("'", index + 1)
            if end < 0:
                raise Unparsed
            word = (word or "") + text[index + 1:end]
            index = end + 1
        elif char == '"':
            word = word or ""
            index += 1
            while True:
                if index >= size:
                    raise Unparsed
                inner = text[index]
                if inner == '"':
                    index += 1
                    break
                if inner == "\\" and index + 1 < size:
                    following = text[index + 1]
                    if following != "\n":
                        word += following if following in '"\\$`' else inner + following
                    index += 2
                elif inner == "`":
                    index = parse(text, index + 1, "`", out, depth + 1)
                    word += DYN
                elif inner == "$":
                    index, piece = dollar(text, index, out, depth)
                    word += piece
                else:
                    word += inner
                    index += 1
        elif char == "`":
            index = parse(text, index + 1, "`", out, depth + 1)
            word = (word or "") + DYN
        elif text.startswith("$'", index):
            end = index + 2
            while end < size and text[end] != "'":
                end += 2 if text[end] == "\\" else 1
            if end >= size:
                raise Unparsed
            word = (word or "") + text[index + 2:end]
            index = end + 1
        elif char == "$":
            index, piece = dollar(text, index, out, depth)
            word = (word or "") + piece
        elif char in " \t":
            if word is not None:
                words.append(word)
                word = None
            index += 1
        elif char == "#" and word is None:
            end = text.find("\n", index)
            index = size if end < 0 else end
        elif char == "\n":
            end_command()
            index += 1
            for delimiter, strip_tabs, quoted, owner in pending:
                found = heredoc_body(text, index, delimiter, strip_tabs, closer)
                if found is None:
                    break  # no terminator: read what follows as commands
                body, index = found
                if any(reads_script_from_stdin(command) for command in out[owner:]):
                    parse(body, 0, None, out, depth + 1)
                elif not quoted:
                    substitutions(body, out, depth + 1)
            pending = []
        elif char in ";|":
            end_command()
            index += 1
            while index < size and text[index] in ";|&":
                index += 1
        elif text.startswith("&>", index):
            if word is not None:
                words.append(word)
                word = None
            index += 2
        elif char == "&":
            end_command()
            index += 2 if text.startswith("&&", index) else 1
        elif char == "(":
            end_command()
            index = parse(text, index + 1, ")", out, depth + 1)
        elif char == ")":
            end_command()  # a case pattern
            index += 1
        elif char in "<>":
            if word is not None:
                words.append(word)
                word = None
            if text.startswith("<<", index) and not text.startswith("<<<", index):
                start = index + 2
                strip_tabs = text.startswith("-", start)
                start += strip_tabs
                while start < size and text[start] in " \t":
                    start += 1
                match = DELIMITER.match(text, start)
                if match:
                    bare = match.group(3)
                    delimiter = bare.lstrip("\\") if bare is not None else match.group(1) or match.group(2) or ""
                    quoted = bare is None or bare.startswith("\\")
                    pending.append((delimiter, strip_tabs, quoted, len(out)))
                    index = match.end()
                else:
                    index += 2
            elif text.startswith(("<(", ">("), index):
                index = parse(text, index + 2, ")", out, depth + 1)
                word = DYN
            else:
                index += 1
                while index < size and text[index] in "<>&|":
                    index += 1
        else:
            word = (word or "") + char
            index += 1
    if closer is not None:
        raise Unparsed
    end_command()
    return size


def rough(command):
    """Fallback for text that could not be parsed: look at what follows each rm word."""
    return any(rm_recursive_force(match.group(1).split()) for match in ROUGH.finditer(command))


def main():
    try:
        payload = json.loads(sys.stdin.buffer.read())
        command = payload["tool_input"]["command"]
        if payload.get("tool_name") != "Bash" or not isinstance(command, str):
            return
    except Exception:
        return
    if "rm" not in command:
        return
    try:
        blocked, reason = script_dangerous(command), REASON
    except (Unparsed, RecursionError):
        blocked, reason = rough(command), REASON_UNPARSED
    if blocked:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))


if __name__ == "__main__":
    main()
