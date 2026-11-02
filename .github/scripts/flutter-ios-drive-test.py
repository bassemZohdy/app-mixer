import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('flutter_ios_drive', Path(__file__).with_name('flutter-ios-drive.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class FlutterIosDriveTest(unittest.TestCase):
    def test_test_failure_is_not_retried(self):
        resets = []
        result = runner.run_with_retry([sys.executable, '-u', '-c', "print('Waiting for VM Service port to be available...'); print('test failed'); raise SystemExit(7)"],
                                       lambda: resets.append(True), vm_timeout=0.2, attempt_timeout=5, attempts=3)
        self.assertEqual(result, 7)
        self.assertEqual(resets, [])

    def test_only_vm_discovery_stall_is_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            counter = Path(directory) / 'attempt'
            program = """import pathlib,sys,time
p=pathlib.Path(sys.argv[1]); n=int(p.read_text()) if p.exists() else 0; p.write_text(str(n+1))
if n==0:
 print('Waiting for VM Service port to be available...',flush=True); time.sleep(3)
else:
 print('VM Service URL on device: http://127.0.0.1:1234/',flush=True)
"""
            resets = []
            result = runner.run_with_retry([sys.executable, '-u', '-c', program, str(counter)],
                                           lambda: resets.append(True), vm_timeout=0.2, attempt_timeout=5, attempts=3)
            self.assertEqual(result, 0)
            self.assertEqual(resets, [True])
            self.assertEqual(counter.read_text(), '2')

    def test_connected_test_may_run_past_discovery_timeout(self):
        program = "import time; print('Waiting for VM Service port to be available...',flush=True); print('VM Service URL on device: http://127.0.0.1:1234/',flush=True); time.sleep(0.4)"
        resets = []
        result = runner.run_with_retry([sys.executable, '-u', '-c', program], lambda: resets.append(True),
                                       vm_timeout=0.1, attempt_timeout=5, attempts=2)
        self.assertEqual(result, 0)
        self.assertEqual(resets, [])

    def test_fragmented_wait_message_still_times_out(self):
        program = "import sys,time; sys.stdout.write('Waiting for VM Service '); sys.stdout.flush(); time.sleep(0.05); sys.stdout.write('port to be available'); sys.stdout.flush(); time.sleep(3)"
        resets = []
        result = runner.run_with_retry([sys.executable, '-u', '-c', program], lambda: resets.append(True),
                                       vm_timeout=0.1, attempt_timeout=5, attempts=1)
        self.assertEqual(result, 124)
        self.assertEqual(resets, [True])

    def test_other_hangs_are_bounded_without_retry(self):
        resets = []
        result = runner.run_with_retry([sys.executable, '-u', '-c', 'import time; time.sleep(3)'],
                                       lambda: resets.append(True), vm_timeout=0.1, attempt_timeout=0.2, attempts=3)
        self.assertEqual(result, 124)
        self.assertEqual(resets, [])

    def test_discovery_retry_limit_fails(self):
        program = "import time; print('Waiting for VM Service port to be available...',flush=True); time.sleep(3)"
        resets = []
        result = runner.run_with_retry([sys.executable, '-u', '-c', program], lambda: resets.append(True),
                                       vm_timeout=0.1, attempt_timeout=5, attempts=2)
        self.assertEqual(result, 124)
        self.assertEqual(resets, [True, True])


if __name__ == '__main__':
    unittest.main()
