// Checks what `npm pack` would publish: the files consumers need are there,
// and tests, build output and local clutter are not.
import { execFileSync } from 'node:child_process';

// Some npm versions (10.x) still run `prepare` on pack despite
// --ignore-scripts, and its build log lands on stdout before the JSON. So turn
// scripts off via the environment too, and parse from the JSON array only.
const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  env: { ...process.env, npm_config_ignore_scripts: 'true' },
});
const jsonStart = output.search(/^\[/m);
if (jsonStart === -1) {
  console.error('No JSON in `npm pack` output:\n' + output);
  process.exit(1);
}
const [pack] = JSON.parse(output.slice(jsonStart));
const files = pack.files.map(f => f.path);

const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'ReactNativeBleLink.podspec',
  'lib/module/index.js',
  'lib/typescript/index.d.ts',
  'src/index.ts',
  'src/NativeBleLink.ts',
  'ios/ReactNativeBleLink.mm',
  'android/build.gradle',
  'android/src/main/AndroidManifest.xml',
  'app.plugin.js',
  'plugin/withBleLink.js',
];
const forbidden = [
  /__tests__\//,
  /^android\/(build|\.gradle|\.cxx)\//,
  /^ios\/build\//,
  /^node_modules\//,
  /^scripts\//,
  /^example\//,
  /^\.github\//,
  /\.DS_Store$/,
];

const missing = required.filter(f => !files.includes(f));
const unwanted = files.filter(f => forbidden.some(re => re.test(f)));

console.log(`${pack.name}@${pack.version}: ${files.length} files, ${pack.size} bytes packed`);
if (missing.length) console.error('Missing:\n  ' + missing.join('\n  '));
if (unwanted.length) console.error('Should not be published:\n  ' + unwanted.join('\n  '));
if (missing.length || unwanted.length) process.exit(1);
console.log('Package contents OK');
