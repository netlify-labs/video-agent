This is a platform experiment. Do not change any repository files and do not commit. Run each step, time it, and report results as a JSON object at the end.

1. Create test files outside the repo: `mkdir -p /tmp/s2 && head -c 2097152 /dev/urandom > /tmp/s2/2mb.bin && head -c 20971520 /dev/urandom > /tmp/s2/20mb.bin && head -c 104857600 /dev/urandom > /tmp/s2/100mb.bin && sha256sum /tmp/s2/*.bin`
2. Show the Netlify CLI version and whether it is logged in or linked: `netlify --version; netlify status 2>&1 | head -20`. Print only the NAMES of environment variables that start with NETLIFY or contain BLOB, TOKEN, SITE, CONTEXT, AGENT or DEPLOY: `env | cut -d= -f1 | grep -Ei 'netlify|blob|token|site|context|agent|deploy' | sort`. Never print values.
3. For each file, time `netlify blobs:set spike-uploads s2/<name> --input /tmp/s2/<name>` and record exit code and stderr.
4. Time `netlify blobs:set videos s2/2mb.bin --input /tmp/s2/2mb.bin` (a second store) and record the result.
5. `netlify blobs:list spike-uploads` and `netlify blobs:get spike-uploads s2/2mb.bin --output /tmp/s2/back.bin && sha256sum /tmp/s2/back.bin`.
6. Interrupted retry: start `netlify blobs:set spike-uploads s2/retry.bin --input /tmp/s2/100mb.bin` in the background, kill it after 1 second, then run it again to completion and record both results.
7. Outbound POST: `curl -sS -o /dev/null -w '%{http_code}' -X POST https://httpbin.org/post -H 'Content-Type: application/json' -d '{"hello":"world"}'`.

Final answer: a fenced ```json block with keys cli, envNames, results (per step: command, exitCode, seconds, error), and notes.
