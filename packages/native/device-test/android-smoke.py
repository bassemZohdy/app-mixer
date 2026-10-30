import re
import subprocess
import time
import xml.etree.ElementTree as ET


def adb(*args):
    return subprocess.run(['adb', *args], check=True, capture_output=True, text=True, timeout=30).stdout


def tree():
    output = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
    start = output.find('<?xml')
    end = output.find('</hierarchy>')
    if start < 0 or end < 0:
        raise ValueError('Could not read Android UI hierarchy')
    return ET.fromstring(output[start:end + len('</hierarchy>')])


def wait_for(predicate, description, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            root = tree()
            nodes = list(root.iter('node'))
            if any('FAIL' in node.get('text', '') for node in nodes):
                raise AssertionError('React Native fixture reported a failure')
            value = predicate(nodes)
            if value is not None:
                return value
        except (ValueError, ET.ParseError, subprocess.SubprocessError):
            pass
        time.sleep(1)
    raise AssertionError('Timed out waiting for ' + description)


def find(nodes, **attributes):
    return next((node for node in nodes if all(node.get(key) == value for key, value in attributes.items())), None)


def tap(node):
    match = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
    if not match:
        raise AssertionError('Invalid control bounds')
    x1, y1, x2, y2 = map(int, match.groups())
    if x1 >= x2 or y1 >= y2:
        raise AssertionError('Control has empty bounds')
    adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))


adb('install', '-r', 'android/app/build/outputs/apk/release/app-release.apk')
adb('shell', 'am', 'force-stop', 'com.mixerdevice')
adb('shell', 'am', 'start', '-n', 'com.mixerdevice/.MainActivity')
field = wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Ada'}), 'accessible field')
wait_for(lambda nodes: find(nodes, text='Device heading'), 'heading')
wait_for(lambda nodes: find(nodes, text='First item'), 'first row item')
wait_for(lambda nodes: find(nodes, text='Second item'), 'second row item')
update = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Update data' and n.get('clickable')=='true'), None), 'data update button')
tap(update)
field = wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Lin'}), 'externally updated field')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name copy', 'text':'Lin'}), 'externally updated second field')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.TextView', 'text':'Lin'}), 'externally updated text')
reject = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Reject invalid' and n.get('clickable')=='true'), None), 'invalid update button')
tap(reject)
wait_for(lambda nodes: find(nodes, text='Rejected safely'), 'rejected update')
wait_for(lambda nodes: find(nodes, text='Device heading'), 'unchanged heading after rejection')
if find(list(tree().iter('node')), text='Wrong heading'):
    raise AssertionError('Rejected component update partially changed the heading')
field = wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Lin'}), 'unchanged field after rejection')
tap(field)
adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
for _ in range(3):
    adb('shell', 'input', 'keyevent', 'KEYCODE_DEL')
adb('shell', 'input', 'text', 'Grace')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Grace'}), 'edited field')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name copy', 'text':'Grace'}), 'second field synchronized')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.TextView', 'text':'Grace'}), 'bound text synchronized')
mirror = wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name copy', 'text':'Grace'}), 'second field')
tap(mirror)
adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
for _ in range(5):
    adb('shell', 'input', 'keyevent', 'KEYCODE_DEL')
adb('shell', 'input', 'text', 'Ada')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Ada'}), 'first field synchronized')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.TextView', 'text':'Ada'}), 'bound text synchronized again')
adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
for _ in range(3):
    adb('shell', 'input', 'keyevent', 'KEYCODE_DEL')
adb('shell', 'input', 'text', 'Grace')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Grace'}), 'first field synchronized again')
adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
button = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Save' and n.get('clickable')=='true' and n.get('enabled')=='true'), None), 'enabled save button')
tap(button)
wait_for(lambda nodes: find(nodes, text='Saved Grace'), 'action with updated value')
wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Save' and n.get('enabled')=='false'), None), 'disabled save button')
print('React Native Android device interaction passed')
