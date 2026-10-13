import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
import gitops  # noqa: E402


class GitOpsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "panel@example.test")
        self.git("config", "user.name", "Panel Test")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, check=True):
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            capture_output=True,
            text=True,
            check=check,
        )

    def write(self, relative, content):
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit_seed(self):
        self.write("src/file with spaces.txt", "one\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "seed")

    def test_status_keeps_partial_and_untracked_changes_distinct(self):
        self.commit_seed()
        self.write("src/file with spaces.txt", "one\ntwo\n")
        self.git("add", "--", "src/file with spaces.txt")
        self.write("src/file with spaces.txt", "one\ntwo\nthree\n")
        self.write("new folder/new file.txt", "new\n")

        status = gitops.git_status(str(self.repo))

        self.assertEqual([f["path"] for f in status["staged"]], ["src/file with spaces.txt"])
        self.assertEqual([f["path"] for f in status["unstaged"]], ["src/file with spaces.txt"])
        self.assertEqual(status["untracked"], ["new folder/new file.txt"])
        diff = gitops.git_diff(str(self.repo), "new folder/new file.txt", untracked=True)
        self.assertIn("+new", diff["patch"])

    def test_merge_conflict_is_reported_and_can_be_aborted(self):
        self.commit_seed()
        initial_branch = gitops._current_branch(str(self.repo))
        self.git("switch", "-qc", "other")
        self.write("src/file with spaces.txt", "other\n")
        self.git("commit", "-qam", "other edit")
        self.git("switch", "-q", initial_branch)
        self.write("src/file with spaces.txt", "main\n")
        self.git("commit", "-qam", "main edit")
        self.git("merge", "other", check=False)

        status = gitops.git_status(str(self.repo))

        self.assertEqual(status["operation"], "merge")
        self.assertEqual(status["conflicts"][0]["path"], "src/file with spaces.txt")
        result = gitops.finish_operation(str(self.repo), abort=True)
        self.assertTrue(result["ok"])
        self.assertEqual(result["operation"], "")

    def test_stash_and_undo_last_commit_keep_work_recoverable(self):
        self.commit_seed()
        self.write("src/file with spaces.txt", "changed\n")
        self.write("new.txt", "new\n")
        pushed = gitops.stash_push(str(self.repo), "test stash")
        self.assertTrue(pushed["ok"])
        self.assertEqual(pushed["stashCount"], 1)
        self.assertFalse(pushed["unstaged"])
        self.assertFalse(pushed["untracked"])

        popped = gitops.stash_pop(str(self.repo))
        self.assertTrue(popped["ok"])
        self.assertEqual(popped["stashCount"], 0)
        self.git("add", "-A")
        self.git("commit", "-qm", "work")

        undone = gitops.undo_last_commit(str(self.repo))
        self.assertTrue(undone["ok"])
        self.assertEqual(
            {entry["path"] for entry in undone["staged"]},
            {"src/file with spaces.txt", "new.txt"},
        )


if __name__ == "__main__":
    unittest.main()
