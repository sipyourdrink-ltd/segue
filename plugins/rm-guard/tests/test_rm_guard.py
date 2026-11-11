"""Runs the hook as Claude Code does: one JSON payload on stdin, decision on stdout."""
import json
import pathlib
import subprocess
import sys
import unittest

HOOK = pathlib.Path(__file__).resolve().parents[1] / "hooks" / "rm_guard.py"

BLOCK = [
    "rm -rf build",
    "rm -fr build",
    "rm -r -f build",
    "rm -f -r build",
    "rm -Rf build",
    "rm --recursive --force build",
    "rm --force -r build",
    "rm -rf -- build",
    "rm -rfv build",
    "/bin/rm -rf build",
    "\\rm -rf build",
    "sudo rm -rf build",
    "sudo -u root rm -rf build",
    "env rm -rf build",
    "FOO=1 rm -rf build",
    "command rm -rf build",
    "nohup rm -rf build",
    "time rm -rf build",
    "cd /tmp && rm -rf build",
    "echo start; rm -rf build",
    "true || rm -rf build",
    "ls | xargs rm -rf",
    "find . -name '*.pyc' -print0 | xargs -0 rm -rf",
    "find . -type d -exec rm -rf {} +",
    "bash -c 'rm -rf build'",
    "sh -c \"cd /tmp && rm -rf build\"",
    "eval 'rm -rf build'",
    "echo $(rm -rf build)",
    "echo `rm -rf build`",
    "(rm -rf build)",
    "{ rm -rf build; }",
    "if true; then rm -rf build; fi",
    "for d in a b; do rm -rf \"$d\"; done",
    "rm -rf \"$TARGET\"",
    "rm -rf build &",
    "ssh host 'rm -rf build'",
    "ssh host rm -rf build",
    "rm build -rf",
    "rm -$FLAGS build",
    "timeout 5 rm -rf build",
    "nice -n 5 rm -rf build",
    "xargs -I{} rm -rf {}",
    "bash <<'EOF'\nrm -rf build\nEOF",
    "cat <<'EOF' | bash\nrm -rf build\nEOF",
    "cat <<EOF\n$(rm -rf build)\nEOF",
    "trap 'rm -rf build' EXIT",
    "case $x in a) rm -rf build;; esac",
    "echo \"${x:-$(rm -rf build)}\"",
    "echo 'unterminated; rm -rf build",
]

ALLOW = [
    "ls -la",
    "rm notes.txt",
    "rm -f notes.txt",
    "rm -r build",
    "rm -i -r build",
    "rmdir build",
    "git status && git log --oneline -3",
    "git rm -r -f docs/old",
    "git commit -m 'stop using rm -rf in the build script'",
    "echo 'rm -rf build'",
    "echo \"never run rm -rf /\"",
    "grep -rn 'rm -rf' scripts/",
    "gh issue create --title cleanup --body 'the script calls rm -rf on the cache'",
    "printf '%s\\n' 'rm -rf build' > notes.txt",
    "npm run build && npm test",
    "python3 -m pytest -q tests",
    "trash build",
    "cat <<'EOF' > notes.txt\nrm -rf build\nEOF",
    "firmware -rf build",
    "rm -f a.txt && ls -r",
    "rm -- -rf",
    "rm -r \"$dir\"",
    "command -v rm",
    "sudo -u rm ls",
    "find . -name '*.log' -delete",
    "bash script.sh",
    "curl -fsSL https://example.com/install.sh | bash",
    "\"$BIN\" --version",
    "$CMD arg",
    "echo 'unterminated",
    "cat <<EOF | tee out.txt\nrm -rf build\nEOF",
    "python3 - <<'EOF'\nprint('rm -rf build')\nEOF",
    "git commit -m \"$(cat <<'EOF'\nDon't call rm -rf in the build script\n\nDetails.\nEOF\n)\"",
    "gh pr create --title t --body \"$(cat <<'EOF'\n## Summary\n- drop rm -rf\nEOF\n)\"",
    "node -e \"console.log('rm -rf build')\"",
    "sed -i '' 's/rm -rf/trash/' build.sh",
    "echo $((1 << 2)); echo rm -rf build",
    "ls > out.txt 2>&1; echo rm",
    "docker run --rm -it image sh",
]


def decide(command, tool="Bash"):
    payload = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {"command": command}}
    run = subprocess.run([sys.executable, "-I", str(HOOK)], input=json.dumps(payload),
                         capture_output=True, text=True, timeout=20)
    if run.returncode != 0:
        return "error"
    if not run.stdout.strip():
        return "allow"
    return json.loads(run.stdout)["hookSpecificOutput"]["permissionDecision"]


class RmGuard(unittest.TestCase):
    def test_blocks_recursive_force(self):
        for command in BLOCK:
            with self.subTest(command=command):
                self.assertEqual(decide(command), "deny")

    def test_allows_everything_else(self):
        for command in ALLOW:
            with self.subTest(command=command):
                self.assertEqual(decide(command), "allow")

    def test_malformed_input_is_allowed(self):
        for text in ("", "not json", "[]", '{"tool_name": "Bash"}'):
            with self.subTest(text=text):
                run = subprocess.run([sys.executable, "-I", str(HOOK)], input=text,
                                     capture_output=True, text=True, timeout=20)
                self.assertEqual((run.returncode, run.stdout), (0, ""))

    def test_other_tools_are_ignored(self):
        self.assertEqual(decide("rm -rf build", tool="Read"), "allow")


if __name__ == "__main__":
    unittest.main()
