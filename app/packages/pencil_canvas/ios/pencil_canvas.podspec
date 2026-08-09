Pod::Spec.new do |s|
  s.name             = 'pencil_canvas'
  s.version          = '0.1.0'
  s.summary          = 'PencilKit canvas platform view for Oidea.'
  s.description      = 'Embeds PKCanvasView + PKToolPicker as a Flutter platform view.'
  s.homepage         = 'https://github.com/optyne/oidea'
  s.license          = { :type => 'MIT' }
  s.author           = { 'Oidea' => 'dev@oadpiz.com' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'
  s.platform         = :ios, '14.0'
  s.swift_version    = '5.0'
end
