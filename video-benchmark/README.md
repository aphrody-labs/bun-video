# Video fork qualification

This benchmark calls actual pinned upstream and migrated source functions with
identical inputs on the same installed Aphrody Bun. It alternates fresh processes,
warms each function, retains every timing/RSS sample, and rejects output mismatch.
It does not measure video encoding or claim Node-versus-Bun speedups.

```sh
bun run packages/bun-video/video-benchmark/runner.ts --remotion-upstream <clean-pinned-checkout> --hyperframes-upstream <clean-pinned-checkout> --aphrody-root <qualified-aphrody-checkout> --samples 7
```

`UPSTREAM.json` in each fork must contain the baseline checkout's exact SHA.
Use `--native-library <absolute-qualified-provider>` to probe a chosen native
tooling/browser artifact without changing the SDK defaults or machine configuration.
Results and generated assets default to ignored `tmp/video-benchmark/`.
The full stack probe calls the actual SDK Oxc provider, builds a custom native
M3 theme, then navigates, executes JavaScript and captures PNG through the Obscura
SDK. Missing providers are reported as blocked; no substitute or fabricated
full-stack timings are used. This integration probe is separate from core CPU
timings and is not an equivalent video-rendering workload.

The vendored sources retain their upstream licenses and notices. A local import
does not create a hosted public fork or change those licenses.
