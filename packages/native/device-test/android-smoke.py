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
heading = wait_for(lambda nodes: find(nodes, text='Device heading'), 'heading')
if heading.get('focusable') != 'true':
    raise AssertionError('Heading must be focusable for accessibility')
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
advance = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Advance surface' and n.get('clickable')=='true'), None), 'surface lifecycle button')
tap(advance)
wait_for(lambda nodes: find(nodes, text='Secondary Ada'), 'second surface')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Grace'}), 'main surface remains intact')
advance = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Advance surface' and n.get('clickable')=='true'), None), 'surface lifecycle button after creation')
tap(advance)
wait_for(lambda nodes: True if not find(nodes, text='Secondary Ada') else None, 'second surface removal')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Grace'}), 'main surface after removal')
advance = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Advance surface' and n.get('clickable')=='true'), None), 'surface lifecycle button after removal')
tap(advance)
wait_for(lambda nodes: find(nodes, text='Secondary Grace'), 'recreated surface with fresh data')
if find(list(tree().iter('node')), text='Secondary Ada'):
    raise AssertionError('Recreated surface retained old data')
wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Name', 'text':'Grace'}), 'main surface after recreation')
layout = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Check narrow layout' and n.get('clickable')=='true'), None), 'narrow layout button')
tap(layout)
labels = ['A long nested column label needs to wrap', 'A long nested card label needs to wrap', 'A long nested row label needs to wrap']
elements = [wait_for(lambda nodes, label=label: find(nodes, text=label), 'nested row label') for label in labels]
density_output = adb('shell', 'wm', 'density')
densities = re.findall(r'(?:Physical|Override) density:\s*(\d+)', density_output)
if not densities:
    raise AssertionError('Could not determine Android display density')
scale = int(densities[-1]) / 160
bounds = []
for element in elements:
    match = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', element.get('bounds', ''))
    if not match:
        raise AssertionError('Invalid nested label bounds')
    bounds.append(tuple(map(int, match.groups())))
left = bounds[0][0]
for x1, y1, x2, y2 in bounds:
    if x2 <= x1 or y2 - y1 <= 20 * scale or x1 < left - 2 or x2 > left + 240 * scale + 2:
        raise AssertionError('Nested row label is not contained and wrapped: ' + str(bounds))
if bounds[0][2] > bounds[1][0] + 2 or bounds[1][2] > bounds[2][0] + 2:
    raise AssertionError('Nested row labels overlap: ' + str(bounds))
identity = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Check surface identity' and n.get('clickable')=='true'), None), 'surface identity button')
tap(identity)
wait_for(lambda nodes: find(nodes, text='Mount 1'), 'initial surface instance')
replace = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Replace test surface' and n.get('clickable')=='true'), None), 'surface replacement button')
tap(replace)
wait_for(lambda nodes: find(nodes, text='Mount 2'), 'replacement surface instance')
if find(list(tree().iter('node')), text='Mount 1'):
    raise AssertionError('Recreated surface retained the previous instance')
multiline = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Check multiline input' and n.get('clickable')=='true'), None), 'multiline test button')
tap(multiline)
notes = wait_for(lambda nodes: find(nodes, **{'class':'android.widget.EditText', 'content-desc':'Notes'}), 'accessible multiline field')
tap(notes)
adb('shell', 'input', 'text', 'First')
adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER')
adb('shell', 'input', 'text', 'Second')
adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
save_note = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Save note' and n.get('clickable')=='true'), None), 'save note button')
tap(save_note)
wait_for(lambda nodes: find(nodes, text='Saved multiline note'), 'multiline action data')
repeated_button = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Check repeated fields' and n.get('clickable')=='true'), None), 'repeated fields button')
tap(repeated_button)
def repeated_fields(nodes, value):
    fields = [n for n in nodes if n.get('class')=='android.widget.EditText' and n.get('content-desc')=='Repeated' and n.get('text')==value]
    return fields if len(fields)==2 else None
fields = wait_for(lambda nodes: repeated_fields(nodes, 'Ada'), 'two repeated fields')
def top(node):
    match = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
    if not match:
        raise AssertionError('Invalid repeated field bounds')
    return int(match.group(2))
marker = wait_for(lambda nodes: find(nodes, text='Reorder marker'), 'initial reorder marker')
if not top(fields[0]) < top(marker) < top(fields[1]):
    raise AssertionError('Repeated field marker did not start between the fields')
tap(fields[0])
adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
for _ in range(3):
    adb('shell', 'input', 'keyevent', 'KEYCODE_DEL')
adb('shell', 'input', 'text', 'Grace')
wait_for(lambda nodes: repeated_fields(nodes, 'Grace'), 'repeated fields synchronize')
adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
tap(wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Reorder fields' and n.get('clickable')=='true'), None), 'reorder fields button'))
fields = wait_for(lambda nodes: repeated_fields(nodes, 'Grace'), 'reordered fields retain data')
marker = wait_for(lambda nodes: find(nodes, text='Reorder marker'), 'reordered marker')
if not top(marker) < top(fields[0]) < top(fields[1]):
    raise AssertionError('Marker did not move before both repeated fields')
tap(fields[1])
adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
for _ in range(5):
    adb('shell', 'input', 'keyevent', 'KEYCODE_DEL')
adb('shell', 'input', 'text', 'Lin')
wait_for(lambda nodes: repeated_fields(nodes, 'Lin'), 'reordered fields remain editable')
adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
signed = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Check signed extension' and n.get('clickable')=='true'), None), 'signed extension button')
tap(signed)
wait_for(lambda nodes: find(nodes, text='Verified signed extension'), 'signed extension rendering')
wait_for(lambda nodes: find(nodes, text='Tampered plan rejected'), 'tampered signed plan rejection')
incremental = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Check incremental layout' and n.get('clickable')=='true'), None), 'incremental layout button')
tap(incremental)

def bounds(node):
    match = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
    if not match:
        raise AssertionError('Invalid layout bounds')
    return tuple(map(int, match.groups()))

def host_node(nodes, direction):
    suffix = direction + '-layout-host'
    return next((n for n in nodes if n.get('resource-id', '').rsplit('/', 1)[-1] == suffix), None)

for direction in ['ltr', 'rtl']:
    nodes = tree().iter('node')
    nodes = list(nodes)
    host = wait_for(lambda current, direction=direction: host_node(current, direction), direction + ' host')
    left = wait_for(lambda current, direction=direction: find(current, text=direction.upper() + ' Left'), direction + ' left child')
    right = wait_for(lambda current, direction=direction: find(current, text=direction.upper() + ' Right'), direction + ' right child')
    if find(nodes, text=direction.upper() + ' Middle'):
        raise AssertionError(direction + ' unresolved child appeared before resolution')
    hx1, _, hx2, _ = bounds(host)
    lx1, _, lx2, _ = bounds(left)
    rx1, _, rx2, _ = bounds(right)
    if not (hx1 <= lx1 <= lx2 <= hx2 and hx1 <= rx1 <= rx2 <= hx2):
        raise AssertionError(direction + ' labels are outside their layout host')
    visible = sorted([('Left', bounds(left)), ('Right', bounds(right))], key=lambda item: item[1][0])
    expected_visible_order = ['Left', 'Right'] if direction == 'ltr' else ['Right', 'Left']
    if [name for name, _ in visible] != expected_visible_order:
        raise AssertionError(direction + ' child order does not follow the host direction')
    remaining = hx2 - hx1 - sum(x2 - x1 for _, (x1, _, x2, _) in visible)
    expected_outer = remaining / 6  # space-around with three slots, including the empty child
    tolerance = max(3, round(3 * scale))
    first_x, last_x = visible[0][1][0], visible[-1][1][2]
    if abs((first_x - hx1) - expected_outer) > tolerance or abs((hx2 - last_x) - expected_outer) > tolerance:
        raise AssertionError(direction + ' unresolved slot spacing differs: ' + str((hx1, first_x, last_x, hx2, expected_outer)))

resolve = wait_for(lambda nodes: next((n for n in nodes if n.get('content-desc')=='Resolve missing child' and n.get('clickable')=='true'), None), 'resolve missing child button')
tap(resolve)
for direction in ['ltr', 'rtl']:
    host = wait_for(lambda current, direction=direction: host_node(current, direction), direction + ' resolved host')
    labels = [wait_for(lambda current, direction=direction, word=word: find(current, text=direction.upper() + ' ' + word), direction + ' ' + word.lower()) for word in ['Left', 'Middle', 'Right']]
    hx1, _, hx2, _ = bounds(host)
    rects = sorted((bounds(label) for label in labels), key=lambda rect: rect[0])
    if any(not (hx1 <= x1 <= x2 <= hx2) for x1, _, x2, _ in rects):
        raise AssertionError(direction + ' resolved labels are outside their layout host')
    expected_order = ['Left', 'Middle', 'Right'] if direction == 'ltr' else ['Right', 'Middle', 'Left']
    named_labels = sorted(zip(['Left', 'Middle', 'Right'], labels), key=lambda item: bounds(item[1])[0])
    if [name for name, _ in named_labels] != expected_order:
        raise AssertionError(direction + ' resolved children do not follow the host direction')
    remaining = hx2 - hx1 - sum(x2 - x1 for x1, _, x2, _ in rects)
    expected_outer, expected_gap = remaining / 6, remaining / 3
    tolerance = max(3, round(3 * scale))
    measured = [rects[0][0] - hx1, rects[1][0] - rects[0][2], rects[2][0] - rects[1][2], hx2 - rects[2][2]]
    expected = [expected_outer, expected_gap, expected_gap, expected_outer]
    if any(abs(actual - target) > tolerance for actual, target in zip(measured, expected)):
        raise AssertionError(direction + ' resolved slot spacing differs: ' + str((measured, expected)))
print('React Native Android device interaction passed')
