# Order quote incident Worker

The Worker returns a quote for a standard or priority order. `GET /health` reports that the Worker can answer a request. `GET /quote?type=priority&quantity=2` returns a quote or HTTP 500 with a request ID.

The healthy and broken pricing functions live in `src/pricing.ts`. The broken function looks up a shipping rule that does not exist for priority orders. The two Wrangler configs deploy different versions of the **same** public Worker: `wrangler.jsonc` sets `healthy-01` and `wrangler.broken.jsonc` sets `broken-02`. This is a controlled deployment configuration that selects a faulty code path; the bug is in `brokenQuote`, not in Cloudflare. Do not use Wrangler environments for this experiment: those would create separate Workers instead of two deployments of one Worker.

In WSL, from this directory:

```sh
source "$HOME/.nvm/nvm.sh"
nvm use 22
npm ci
npm test
npm run dev
```

In another WSL terminal, from the project root, test the local healthy Worker:

```sh
node scripts/traffic.mjs http://127.0.0.1:8787 3 0
```

Stop `npm run dev` and run `npm run dev:broken` to inspect the broken variant locally. The healthy variant returns 15 successes over three cycles. The broken variant returns six HTTP 500 responses, and the client emits `synthetic.alert` after its second complete cycle. This alert measures only the requests sent by this script.

For deployment instructions and the evidence to capture, see `../../docs/days/day-01.md`. Samuel runs the Cloudflare login and live deploy commands himself.
