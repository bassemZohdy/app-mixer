"""Run Flutter iOS integration tests with a bounded retry for VM discovery stalls."""
import os
import selectors
import signal
import subprocess
import sys
import time

WAITING = b'Waiting for VM Service port to be available'
CONNECTED = b'VM Service URL on device:'


def stop_group(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def run_once(command, vm_timeout, attempt_timeout):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    started = time.monotonic()
    waiting_since = None
    connected = False
    tail = b''
    try:
        while True:
            for key, _ in selector.select(timeout=0.1):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                tail = (tail + chunk)[-8192:]
                if CONNECTED in tail:
                    connected = True
                    waiting_since = None
                elif WAITING in tail and not connected and waiting_since is None:
                    waiting_since = time.monotonic()
            now = time.monotonic()
            code = process.poll()
            if code is not None and not selector.get_map():
                return code
            if code is None and waiting_since is not None and now - waiting_since >= vm_timeout:
                stop_group(process)
                return None
            if now - started >= attempt_timeout:
                stop_group(process)
                return 124
    finally:
        selector.close()
        process.stdout.close()
        stop_group(process)


def run_with_retry(command, reset, vm_timeout=120, attempt_timeout=900, attempts=3):
    for attempt in range(1, attempts + 1):
        print(f'Flutter iOS integration attempt {attempt}/{attempts}', flush=True)
        result = run_once(command, vm_timeout, attempt_timeout)
        if result is not None:
            return result
        print('Flutter VM service discovery stalled; stopping the simulator app.', flush=True)
        reset()
    print('Flutter VM service discovery did not succeed within the retry limit.', file=sys.stderr, flush=True)
    return 124


def main():
    if len(sys.argv) != 2 or not sys.argv[1]:
        raise SystemExit('Usage: flutter-ios-drive.py SIMULATOR_ID')
    simulator = sys.argv[1]
    command = ['flutter', 'drive', '--verbose', '--driver=test_driver/integration_test.dart',
               '--target=integration_test/renderer_device_test.dart', '-d', simulator]
    def reset():
        subprocess.run(['xcrun', 'simctl', 'terminate', simulator, 'com.example.adapterDeviceTest'],
                       check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    raise SystemExit(run_with_retry(command, reset))


if __name__ == '__main__':
    main()
