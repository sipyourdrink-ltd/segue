# rm-guard

A Claude Code plugin with one hook. Before a Bash command runs, the hook reads its text and refuses it when it would run `rm` with both a recursive and a force flag.

```bash
claude plugin marketplace add sipyourdrink-ltd/segue
```

```bash
claude plugin install rm-guard@sipyourdrink
```

Needs `python3` on the path. No dependencies, no options.

## What is refused

`rm -rf x`, `rm -fr x`, `rm -r -f x`, `rm --recursive --force x`, `rm x -rf`, and the same call when it is:

- behind a wrapper: `sudo`, `env`, `nohup`, `time`, `timeout`, `nice`, `xargs`, `command`, `exec`;
- inside `find … -exec`, `sh -c`, `bash -c`, `eval`, `trap`, an `ssh` command line;
- inside `$( … )`, backticks, a subshell, a `{ …; }` group, `if`, `for`, `case`;
- in a here-document that is fed to a shell;
- written with flags the hook cannot read, such as `rm -$FLAGS x`.

The agent gets the reason back and is told to remove the named files one by one or to ask you to run the command.

## What is not refused

- `rm` without both flags: `rm notes.txt`, `rm -f notes.txt`, `rm -r build`.
- The words inside data: `echo 'rm -rf build'`, a commit message, a `grep` pattern, a here-document written to a file, a script given to `python3` or `node`.
- Other ways to delete: `find -delete`, `git clean`, `git rm`, a script on disk (`bash script.sh`), a program named by a variable (`$CMD arg`), an alias.

The hook parses text. It does not expand variables, read scripts or run anything, so it is a guard against one common mistake and not a sandbox. Text it cannot parse, such as an unclosed quote, is refused only when an `rm` word in it is followed by both flags.

## Tests

```bash
python3 plugins/rm-guard/tests/test_rm_guard.py
```

The lists of refused and allowed commands in that file are the specification.

## License

[Apache-2.0](../../LICENSE).
