import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("support_sources", Path(__file__).parent / "lib/sources.py")
sources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sources)
URL = "https://forms.gle/ExampleSupport123"


class SupportSourcesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.user = self.base / "user"
        self.user.mkdir()
        self.env = mock.patch.dict(os.environ, {"PANEL_USER_HOME": str(self.user), "APPGEA_ROOT": "",
                                               "PANEL_STATE_DIR": str(self.base / "state")})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def project(self, folder, name):
        root = self.base / folder
        root.mkdir()
        (root / "README.md").write_text(URL)
        return {"path": str(root), "name": name}

    def configure(self, projects):
        (self.user / "config.json").write_text(json.dumps({"projects": projects}))

    def test_installed_module_scans_registered_projects_and_merges_the_same_form(self):
        one = self.project("repo one", "First")
        two = self.project("repo two", "Second")
        self.project("unregistered", "Hidden")
        ignored = Path(one["path"]) / "node_modules"
        ignored.mkdir()
        (ignored / "README.md").write_text("https://forms.gle/NotOurForm456")
        self.configure([one, two, one, {"path": str(self.base), "role": "collection"}, {}, None])
        got = sources.scan()
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["url"], URL)
        self.assertEqual(got[0]["apps"], ["First", "Second"])
        self.assertEqual(got[0]["sites"], ["First/README.md", "Second/README.md"])

    def test_fresh_or_bad_config_never_scans_bundle_ancestors(self):
        self.project("outside", "Hidden")
        for text in [None, "invalid json", "[]", '{"projects": null}']:
            if text is not None:
                (self.user / "config.json").write_text(text)
            self.assertEqual(sources.scan(), [])

    def test_explicit_workspace_override_still_scans_app_folders(self):
        self.project("Repo", "First")
        with mock.patch.dict(os.environ, {"APPGEA_ROOT": str(self.base)}):
            got = sources.scan()
        self.assertEqual(got[0]["apps"], ["Repo"])

    def test_credential_discovery_uses_registered_roots_without_copying_keys(self):
        project = self.project("Repo", "First")
        self.configure([project])
        key = Path(project["path"]) / "play-store-key.json"
        key.write_text(json.dumps({"type": "service_account", "client_email": "robot@example.com"}))
        host_spec = importlib.util.spec_from_file_location("support_host", Path(__file__).parent / "bin/host.py")
        host = importlib.util.module_from_spec(host_spec)
        host_spec.loader.exec_module(host)
        host.sources = sources
        with mock.patch.object(host.gauth, "register_key_paths") as register:
            got = host.do_autodiscover()
        self.assertEqual(got, {"registered": ["robot@example.com"], "candidates": 1})
        register.assert_called_once_with([str(key.resolve())])
        self.assertFalse((self.base / "state/secrets").exists())


if __name__ == "__main__":
    unittest.main()
