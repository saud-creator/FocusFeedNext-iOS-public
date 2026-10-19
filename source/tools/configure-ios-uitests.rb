require 'xcodeproj'
require 'fileutils'
project_path = Dir['src-tauri/gen/apple/*.xcodeproj'].first or abort 'Missing generated Xcode project'
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |t| t.product_type == 'com.apple.product-type.application' } or abort 'Missing app target'
# Tauri's CLI has already built the simulator Rust library. Its temporary IPC
# server is no longer running during xcodebuild test. Reuse that exact library.
rust_phases = app.shell_script_build_phases.select { |p| p.name.to_s.match?(/rust/i) || p.shell_script.to_s.include?('xcode-script') }
abort 'Could not identify the generated Rust build phase' if rust_phases.empty?
rust_phases.each { |p| p.shell_script = 'echo "Using simulator Rust library built by Tauri"' }
tests = project.new_target(:ui_test_bundle, 'FocusFeedUITests', :ios, '16.0')
tests.add_dependency(app)
group = project.main_group.new_group('FocusFeedUITests', File.expand_path('tools/ios-ui-tests'))
tests.add_file_references([group.new_file('ReaderUITests.swift')])
tests.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER'=>'com.focusfeed.next.uitests',
    'GENERATE_INFOPLIST_FILE'=>'YES', 'SWIFT_VERSION'=>'5.0',
    'CODE_SIGNING_ALLOWED'=>'NO', 'CODE_SIGNING_REQUIRED'=>'NO',
    'TEST_TARGET_NAME'=>app.name,
    'TARGETED_DEVICE_FAMILY'=>'1'
  })
end
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_build_target(tests)
scheme.add_test_target(tests)
scheme.set_launch_target(app)
scheme.test_action.build_configuration = 'debug'
# Match the generator's case-sensitive configuration name.
scheme.test_action.build_configuration = app.build_configurations.find { |c| c.name.downcase == 'debug' }.name
scheme.save_as(project_path, 'FocusFeedUITests', true)
project.save
puts "Configured UI tests for #{app.name}"
