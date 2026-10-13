import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class StartupTests(unittest.TestCase):
    def test_fresh_checkout_in_a_path_with_spaces_installs_once_and_keeps_no_watch(self):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="panel startup ") as tmp:
            root = Path(tmp).resolve() / "checkout with spaces" / "next"
            for rel in ["dev.command", "launcher/prepare-ui.sh", "apps/desktop/ui/package.json",
                        "apps/desktop/ui/package-lock.json"]:
                target = root / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source / rel, target)
            (root / "apps/desktop/src-tauri").mkdir()
            # A failed npm ci can leave a directory behind without a usable toolchain.
            (root / "apps/desktop/ui/node_modules").mkdir()
            tools = Path(tmp) / "tools"
            tools.mkdir()
            log = Path(tmp) / "calls.jsonl"
            stub = '''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["STARTUP_ROOT"])
if pathlib.Path(sys.argv[0]).name == "npm":
    ui = root / "apps/desktop/ui"
    assert sys.argv[1:] == ["--prefix", str(ui), "ci", "--engine-strict"], sys.argv
    assert (ui / "package-lock.json").is_file()
    bins = ui / "node_modules/.bin"
    bins.mkdir(parents=True, exist_ok=True)
    for name in ["vite", "tsc"]:
        binary = bins / name
        binary.write_text("")
        binary.chmod(0o755)
else:
    assert pathlib.Path.cwd() == root / "apps/desktop/src-tauri"
with open(os.environ["STARTUP_LOG"], "a") as f:
    f.write(json.dumps({"tool": pathlib.Path(sys.argv[0]).name, "args": sys.argv[1:]}) + "\\n")
'''
            for name in ["npm", "cargo"]:
                p = tools / name
                p.write_text(stub)
                p.chmod(0o755)
            # Staging copies host/ into the bundle tree. Its own work is not under test here, only
            # that a fresh clone runs it before every start.
            stage = root / "launcher/stage-resources.sh"
            stage.write_text('#!/usr/bin/env python3\nimport json, os\n'
                             'open(os.environ["STARTUP_LOG"], "a").write(json.dumps({"tool": "stage", "args": []}) + "\\n")\n')
            stage.chmod(0o755)
            env = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                   "STARTUP_ROOT": str(root), "STARTUP_LOG": str(log), "PANEL_FROZEN": "0"}
            for args, frozen in [(["--no-watch"], "0"), ([], "1"), ([], "0")]:
                result = subprocess.run([str(root / "dev.command"), *args], cwd=tmp,
                                        env={**env, "PANEL_FROZEN": frozen}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual([c["tool"] for c in calls],
                             ["stage", "npm", "cargo", "stage", "cargo", "stage", "cargo"])
            self.assertEqual([c["args"] for c in calls if c["tool"] == "cargo"],
                             [["tauri", "dev", "--no-watch"], ["tauri", "dev", "--no-watch"], ["tauri", "dev"]])


if __name__ == "__main__":
    unittest.main()
