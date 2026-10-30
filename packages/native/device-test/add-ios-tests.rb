require 'xcodeproj'

project_path = 'MixerDevice.xcodeproj'
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == 'MixerDevice' }
raise 'App target missing' unless app
ui = project.new_target(:ui_test_bundle, 'MixerDeviceUITests', :ios, '15.1')
ui.add_dependency(app)
group = project.main_group.new_group('MixerDeviceUITests', 'MixerDeviceUITests')
ui.source_build_phase.add_file_reference(group.new_file('MixerDeviceUITests.swift'))
ui.build_configurations.each do |config|
  config.build_settings['PRODUCT_NAME'] = '$(TARGET_NAME)'
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.appmixer.MixerDeviceUITests'
  config.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['TEST_TARGET_NAME'] = 'MixerDevice'
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(app, ui, launch_target: true)
scheme.test_action.build_configuration = 'Release'
scheme.save_as(project_path, 'MixerDeviceUITests', true)
