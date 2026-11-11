"""Runs the hook as Claude Code does: one JSON payload on stdin, a line appended on disk."""
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

HOOK = pathlib.Path(__file__).resolve().parents[1] / "hooks" / "audit_log.py"


def payload(tool, tool_input, **extra):
    base = {
        "session_id": "s-1",
        "transcript_path": "/tmp/t.jsonl",
        "cwd": "/work/project",
        "hook_event_name": "PostToolUse",
        "tool_name": tool,
        "tool_input": tool_input,
        "tool_response": {"stdout": "OUTPUT-MUST-NOT-BE-LOGGED"},
        "tool_use_id": "toolu_1",
    }
    base.update(extra)
    return base


class AuditLog(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = pathlib.Path(self.temp.name) / "data"

    def run_hook(self, stdin, data=None):
        env = {"PATH": os.environ.get("PATH", ""), "HOME": self.temp.name,
               "CLAUDE_PLUGIN_DATA": str(data or self.data)}
        if isinstance(stdin, dict):
            stdin = json.dumps(stdin)
        return subprocess.run([sys.executable, "-I", str(HOOK)], input=stdin.encode(),
                              capture_output=True, env=env, timeout=30)

    def lines(self, data=None):
        files = sorted((data or self.data).glob("audit-*.jsonl"))
        self.assertEqual(len(files), 1, files)
        return files[0], [json.loads(line) for line in files[0].read_text().splitlines()]

    def test_bash_call_is_one_line_with_the_command(self):
        result = self.run_hook(payload("Bash", {"command": "git status", "description": "Show status"},
                                       duration_ms=42, agent_id="a-7"))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))
        path, entries = self.lines()
        self.assertRegex(path.name, r"\Aaudit-\d{4}-\d{2}-\d{2}\.jsonl\Z")
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertRegex(entry.pop("ts"), r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")
        self.assertEqual(entry, {
            "session": "s-1", "cwd": "/work/project", "tool": "Bash", "id": "toolu_1",
            "input": {"description": "Show status", "command": "git status"},
            "agent": "a-7", "ms": 42,
        })

    def test_output_is_never_written(self):
        self.run_hook(payload("Bash", {"command": "ls"}))
        path, _ = self.lines()
        self.assertNotIn("OUTPUT-MUST-NOT-BE-LOGGED", path.read_text())

    def test_file_bodies_and_edit_text_become_sizes(self):
        self.run_hook(payload("Write", {"file_path": "/work/project/a.txt", "content": "x" * 5000}))
        self.run_hook(payload("Edit", {"file_path": "/work/project/a.txt", "old_string": "before-text",
                                       "new_string": "after-text", "replace_all": False}))
        path, entries = self.lines()
        self.assertEqual(entries[0]["input"], {"file_path": "/work/project/a.txt", "content": {"chars": 5000}})
        self.assertEqual(entries[1]["input"], {"file_path": "/work/project/a.txt", "old_string": {"chars": 11},
                                               "new_string": {"chars": 10}, "replace_all": False})
        self.assertNotIn("before-text", path.read_text())

    def test_credentials_are_masked(self):
        # Made-up values, assembled here so that no credential-shaped string sits in the repository.
        tail = "abcdefghijklmnop"
        bearer = tail + "1234"
        prefixed = {"sk-": tail + "qrstuvwx", "ghp_": tail + "qrstuvwxyz0123456789", "AKIA": tail.upper()}
        dashes = "-" * 5
        key_body = "MIIE" + "pAIBAAKCAQEA"
        key_block = "%sBEGIN RSA PRIVATE KEY%s\n%s\n%sEND RSA PRIVATE KEY%s" % (dashes, dashes, key_body, dashes, dashes)
        secrets = {
            "curl -H 'Authorization: Bearer %s' https://example.test" % bearer: bearer,
            "export API_KEY=zzz-very-private-value": "zzz-very-private-value",
            "mysql --password hunter2hunter2 -e 'select 1'": "hunter2hunter2",
            "git clone https://user:p4ssw0rd-in-url@example.test/r.git": "p4ssw0rd-in-url",
            "deploy --api-key \"quoted private value\" --region eu": "quoted private value",
            "TOKEN: 'yaml-style-private' run": "yaml-style-private",
            "printf '%%s' '%s'" % key_block: key_body,
        }
        for prefix, rest in prefixed.items():
            secrets["echo " + prefix + rest] = prefix + rest
        for command in secrets:
            self.run_hook(payload("Bash", {"command": command}))
        self.run_hook(payload("mcp__vault__store", {"name": "db", "token": "plain-token-value", "tags": ["a"]}))
        path, entries = self.lines()
        text = path.read_text()
        for command, secret in secrets.items():
            self.assertNotIn(secret, text, command)
        self.assertNotIn("plain-token-value", text)
        self.assertEqual(entries[-1]["input"], {"name": "db", "token": "[masked]", "tags": ["a"]})
        self.assertIn("https://example.test", entries[0]["input"]["command"])

    def test_ordinary_commands_are_kept_as_written(self):
        commands = ["git log --author=alex --oneline", "pytest -k 'token_bucket' tests/", "ls -la src/auth",
                    "grep -rn 'password' docs/", "make build TARGET=release", "echo the token expired",
                    "cat secrets/README.md", "tool --token-file --verbose"]
        for command in commands:
            self.run_hook(payload("Bash", {"command": command}))
        _, entries = self.lines()
        self.assertEqual([entry["input"]["command"] for entry in entries], commands)

    def test_long_values_are_cut_with_a_count(self):
        self.run_hook(payload("Bash", {"command": "echo " + "a" * 5000}))
        self.run_hook(payload("Grep", {"pattern": "b" * 1000, "paths": list(range(100))}))
        _, entries = self.lines()
        self.assertEqual(entries[0]["input"]["command"], "echo " + "a" * 1995 + "...(+3005 chars)")
        self.assertEqual(entries[1]["input"]["pattern"], "b" * 300 + "...(+700 chars)")
        self.assertEqual(entries[1]["input"]["paths"], list(range(40)) + ["...(+60 items)"])

    def test_file_and_folder_are_private(self):
        self.run_hook(payload("Bash", {"command": "ls"}))
        path, _ = self.lines()
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o700)

    def test_falls_back_to_the_home_folder(self):
        env = {"PATH": os.environ.get("PATH", ""), "HOME": self.temp.name}
        result = subprocess.run([sys.executable, "-I", str(HOOK)], capture_output=True, env=env, timeout=30,
                                input=json.dumps(payload("Read", {"file_path": "/work/project/a.txt"})).encode())
        self.assertEqual(result.returncode, 0, result.stderr)
        _, entries = self.lines(pathlib.Path(self.temp.name) / ".claude" / "audit-log")
        self.assertEqual(entries[0]["input"], {"file_path": "/work/project/a.txt"})

    def test_bad_input_writes_nothing_and_does_not_block(self):
        for stdin in ("not json", "[]", json.dumps({"tool_input": {}})):
            result = self.run_hook(stdin)
            self.assertEqual(result.returncode, 1, stdin)  # 1 is shown to the user; 2 would block
            self.assertTrue(result.stderr.startswith(b"audit-log: entry not written: "), result.stderr)
            self.assertNotIn(b"Traceback", result.stderr)
        self.assertFalse(self.data.exists())

    def test_unwritable_folder_is_reported(self):
        blocker = pathlib.Path(self.temp.name) / "file"
        blocker.write_text("")
        result = self.run_hook(payload("Bash", {"command": "ls"}), data=blocker / "data")
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stderr.startswith(b"audit-log: entry not written: "), result.stderr)
        self.assertNotIn(b"Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
