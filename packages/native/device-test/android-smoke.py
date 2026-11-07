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
    last_tree = None
    while time.monotonic() < deadline:
        try:
            root = tree()
            last_tree = root
            nodes = list(root.iter('node'))
            if any('FAIL' in node.get('text', '') for node in nodes):
                raise AssertionError('React Native fixture reported a failure')
            value = predicate(nodes)
            if value is not None:
                return value
        except (ValueError, ET.ParseError, subprocess.SubprocessError):
            pass
        time.sleep(1)
    details = ET.tostring(last_tree, encoding='unicode') if last_tree is not None else 'No hierarchy available'
    raise AssertionError('Timed out waiting for ' + description + '\n' + details)


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
# The shared accessibility reference replaces the interactive surface.
tap(wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Show reference' and n.get('clickable')=='true'), None), 'reference button'))
for text in ['Account', 'Profile', 'Contact details', 'Preferences', 'Advanced', 'Body copy', 'Small print', 'Inside a card']:
    wait_for(lambda nodes, text=text: find(nodes, text=text), 'reference text ' + text)
for text in ['3', '2.5', '4', 'true', 'false']:
    wait_for(lambda nodes, text=text: find(nodes, text=text), 'reference bound scalar ' + text)
# Component IDs are exposed as testID, which Android reports as the resource id.
for component in ['h1', 'h2', 'body', 'name', 'notes', 'save', 'stat-count']:
    wait_for(lambda nodes, component=component: next((n for n in nodes if n.get('resource-id', '').split('/')[-1] == component), None), 'testID hook ' + component)
# Headings are exposed with the header role, which Android reports as a different class from body text. The platform tree has no heading level.
nodes = list(tree().iter('node'))
classes = {component: next(n.get('class') for n in nodes if n.get('resource-id', '').split('/')[-1] == component) for component in ['h1', 'h2', 'body']}
if classes['h1'] == classes['body'] or classes['h2'] == classes['body']:
    raise AssertionError('Headings are not exposed with a role different from body text: ' + repr(classes))
print('React Native Android heading roles: ' + repr(classes))
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Ada'}), 'reference single-line field')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Notes', 'text':'Line one'}), 'reference multiline field')
wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Save' and n.get('clickable')=='true' and n.get('enabled')=='true'), None), 'reference enabled button')
sizes = wait_for(lambda nodes: (lambda found: found if all(node is not None for node in found.values()) else None)({text: next((n for n in nodes if n.get('text')==text), None) for text in ['Account', 'Profile', 'Contact details', 'Body copy', 'Small print']}), 'reference text bounds')
heights = {text: (lambda m: int(m.group(4))-int(m.group(2)))(re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds'))) for text, node in sizes.items()}
# Line heights follow the reference sizes: h1 > h2 > h3 > body > caption.
if not heights['Account'] > heights['Profile'] > heights['Contact details'] > heights['Body copy'] > heights['Small print']:
    raise AssertionError('Text heights do not follow the reference sizes: ' + repr(heights))
print('React Native Android reference parity passed: ' + repr(heights))
# Row `justify` places a label at the start, the centre and the end of the screen width.
tap(wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Show layout' and n.get('clickable')=='true'), None), 'layout button'))
def bounds_of(node):
    return tuple(map(int, re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds')).groups()))
placed = wait_for(lambda nodes: (lambda found: found if all(node is not None for node in found.values()) else None)({text: next((n for n in nodes if n.get('text')==text), None) for text in ['Row start', 'Row center', 'Row end']}), 'justified row labels')
width = max(bounds_of(node)[2] for node in tree().iter('node'))
start, center, end = (bounds_of(placed[text]) for text in ['Row start', 'Row center', 'Row end'])
middle = (center[0] + center[2]) / 2
if not (start[0] < center[0] < end[0] and start[0] <= width * 0.1 and end[2] >= width * 0.9 and abs(middle - width / 2) <= width * 0.1):
    raise AssertionError('Row justify did not place the labels at the start, centre and end: ' + repr((start, center, end, width)))
print('React Native Android row justify passed: ' + repr((start, center, end, width)))
print('React Native Android device interaction passed')
