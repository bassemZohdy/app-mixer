// Generated copy of fixtures/accessibility.json for device tests, which cannot read host files.
// renderer_test.dart fails if the two differ.
const accessibilityFixtureJson = r'''{
  "description": "Accessibility and typography reference shared by the web renderer (checked against a real browser's accessibility tree and computed styles) and the Flutter widgets (checked against the semantics tree, in the VM and on Android and iOS emulators). Font sizes are CSS pixels on the web and logical pixels in Flutter.",
  "messages": [
    {"version":"v0.9.1","createSurface":{"surfaceId":"main","catalogId":"https://raw.githubusercontent.com/bassemZohdy/app-mixer/main/packages/web/catalog/v1/catalog.json"}},
    {"version":"v0.9.1","updateDataModel":{"surfaceId":"main","value":{"form":{"name":"Ada","notes":"Line one"},"stats":{"count":3,"ratio":2.5,"whole":4.0,"active":true,"off":false,"missing":null}}}},
    {"version":"v0.9.1","updateComponents":{"surfaceId":"main","components":[
      {"id":"root","component":"Column","children":["h1","h2","h3","h4","h5","body","caption","card","name","notes","stat-count","stat-ratio","stat-whole","stat-active","stat-off","stat-missing","save"]},
      {"id":"h1","component":"Text","text":"Account","variant":"h1"},
      {"id":"h2","component":"Text","text":"Profile","variant":"h2"},
      {"id":"h3","component":"Text","text":"Contact details","variant":"h3"},
      {"id":"h4","component":"Text","text":"Preferences","variant":"h4"},
      {"id":"h5","component":"Text","text":"Advanced","variant":"h5"},
      {"id":"body","component":"Text","text":"Body copy"},
      {"id":"caption","component":"Text","text":"Small print","variant":"caption"},
      {"id":"card","component":"Card","child":"cardText"},
      {"id":"cardText","component":"Text","text":"Inside a card"},
      {"id":"stat-count","component":"Text","text":{"path":"/stats/count"}},
      {"id":"stat-ratio","component":"Text","text":{"path":"/stats/ratio"}},
      {"id":"stat-whole","component":"Text","text":{"path":"/stats/whole"}},
      {"id":"stat-active","component":"Text","text":{"path":"/stats/active"}},
      {"id":"stat-off","component":"Text","text":{"path":"/stats/off"}},
      {"id":"stat-missing","component":"Text","text":{"path":"/stats/missing"}},
      {"id":"name","component":"TextField","label":"Name","value":{"path":"/form/name"}},
      {"id":"notes","component":"TextField","label":"Notes","value":{"path":"/form/notes"},"variant":"longText"},
      {"id":"save","component":"Button","child":"saveLabel","action":{"event":{"name":"save","context":{"name":{"path":"/form/name"}}}}},
      {"id":"saveLabel","component":"Text","text":"Save"}
    ]}}
  ],
  "semantics": [
    {"name":"Account","role":"heading","level":1},
    {"name":"Profile","role":"heading","level":2},
    {"name":"Contact details","role":"heading","level":3},
    {"name":"Preferences","role":"heading","level":4},
    {"name":"Advanced","role":"heading","level":5},
    {"name":"Body copy","role":"text"},
    {"name":"Small print","role":"text"},
    {"name":"Inside a card","role":"text"},
    {"name":"3","role":"text"},
    {"name":"2.5","role":"text"},
    {"name":"4","role":"text"},
    {"name":"true","role":"text"},
    {"name":"false","role":"text"},
    {"name":"Name","role":"textbox","value":"Ada","multiline":false},
    {"name":"Notes","role":"textbox","value":"Line one","multiline":true},
    {"name":"Save","role":"button","enabled":true}
  ],
  "typography": [
    {"text":"Account","fontSize":32,"bold":true},
    {"text":"Profile","fontSize":24,"bold":true},
    {"text":"Contact details","fontSize":18.72,"bold":true},
    {"text":"Preferences","fontSize":16,"bold":true},
    {"text":"Advanced","fontSize":13.28,"bold":true},
    {"text":"Body copy","fontSize":16,"bold":false},
    {"text":"Small print","fontSize":13.33,"bold":false},
    {"text":"Inside a card","fontSize":16,"bold":false}
  ]
}
''';
