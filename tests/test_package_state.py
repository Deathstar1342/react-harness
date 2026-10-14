import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).parent.parent / 'packaging/maintenance.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PackageStateTests(unittest.TestCase):
    def query(self, status, code=0, error=''):
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, status, error)) as run:
            value = module.package_state('react-harness')
            self.assertEqual(run.call_args.kwargs['timeout'], 5)
            self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'C')
            return value

    def test_desired_removal_does_not_change_current_installed_state(self):
        for selected in ('install', 'hold', 'deinstall', 'purge'):
            self.assertEqual(self.query(selected + ' ok installed'), 'installed')

    def test_transitions_are_preserved_for_guard(self):
        for state in ('unpacked', 'half-installed', 'half-configured', 'triggers-awaited', 'triggers-pending'):
            self.assertEqual(self.query('install ok ' + state), state)

    def test_only_exact_missing_package_diagnostic_confirms_absence(self):
        self.assertEqual(self.query('', 1, 'dpkg-query: no packages found matching react-harness\n'), 'not-installed')
        for code, output, error in [(1, '', 'database unavailable'), (2, '', ''), (0, '', ''), (0, 'install reinstreq installed', ''), (0, 'install ok installed\n', ''), (0, 'install ok installed', 'unexpected warning')]:
            with self.assertRaises(RuntimeError): self.query(output, code, error)

    def test_query_timeout_and_command_failure_are_not_absence(self):
        for error in (OSError('missing executable'), subprocess.TimeoutExpired('dpkg-query', 5)):
            with patch.object(module.subprocess, 'run', side_effect=error):
                with self.assertRaises(type(error)): module.package_state('react-harness')

if __name__ == '__main__': unittest.main()
