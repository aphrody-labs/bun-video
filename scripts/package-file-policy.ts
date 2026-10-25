export function publicPackageFile(name: string): boolean {
  return !/(^|\/)(?:\.git|\.bun|node_modules|target|\.local|\.claude|\.codex|\.ssh|test|tests|__tests__|testdata|fixtures|__snapshots__|visual-test|cookies|sessions|credentials|old-version[^/]*)(\/|$)|(^|\/)(?:\.env[^/]*|cookies?\.json|cookie-reference\.json|credentials\.json|hls\.json)(\/|$)|(?:\.test|\.spec)\.[^/]+$|\.(?:har|sqlite(?:-.*)?|db|pem|p12|safetensors|gguf|mp4|mkv|avi|wav|mp3|flac)$/i.test(
    name,
  );
}
