# Anatomy of an Automated Incident Response System

An error rate climbs right after a deployment. The on-call engineer faces one question: is there enough evidence to roll back, or is the cause still unknown? This article describes how I built that exact situation on purpose, which signals it produced, and what each signal could and could not establish.

## How the incident was created

The service is a small order-quote API on a public Cloudflare Worker. It accepts standard and priority orders and returns a price. Two deployments of the same Worker created the incident:

- Healthy version `3e9e73ee`, release label `healthy-01`: quotes both order types.
- Broken version `14ba0d70`, release label `broken-02`: a shipping-rule lookup refers to a rule named `express` instead of `priority`. Every priority quote throws `Cannot read properties of undefined (reading 'fee')`. Standard quotes still succeed.

A fixed traffic script sends three standard and two priority orders per cycle. When the broken version receives all traffic, the predicted HTTP 500 rate is 2 of 5 requests (40%). The prediction held: two complete live cycles each measured exactly 40%.

## Which signals were available

**The traffic sample.** The client script reported per-cycle error rates and raised a synthetic alert after two complete high-error cycles. It measures only its own requests. One cycle was incomplete — three requests failed in transit before receiving any HTTP response — and the checker correctly refused to count it as a five-request sample. A monitor that cannot distinguish "the server returned 500" from "my request never arrived" will misreport both.

**The platform invocation log.** Cloudflare records each request with its path, response status, and serving version. One entry showed `GET /quote?type=priority&quantity=2`, status 500, served by version `14ba0d70`. This links a failure to a deployment. It does not explain the failure: the same entry reports `outcome: ok`, because the Worker caught the error and returned a 500 response instead of crashing.

**The application log.** The Worker's own `console.error` entry carried the fields the platform log lacks: app request ID `25f5a1b8-...`, release `broken-02`, order type `priority`, and the error text. This is the entry that names the cause. Without it, the investigation stops at "priority orders fail on the new version" and never reaches "the shipping-rule lookup is wrong."

**The deployment history.** The dashboard showed version `14ba0d70` at 100% of traffic with the healthy `3e9e73ee` directly below it. That ordering turns correlation into a testable claim: every failure carries the new version's ID.

**Two signals that mislead.** The dashboard's error-rate gauge read 0% during the incident, because it counts uncaught Worker crashes — and this Worker never crashed. And `GET /health` returned 200 throughout, because it checks that the Worker answers requests, not that quotes are correct. A response system that watches only platform health will report a green service while every priority customer fails.

## What an engineer needs before responding

Four items, each tied to observed evidence:

1. The affected slice: priority orders only, from the traffic mix and the `type` field in failing logs.
2. The failing version: `14ba0d70`, from the version ID on failed requests and 100% traffic on that deployment.
3. The causal error: the shipping-rule lookup failure, from the application log — not inferred from the error rate.
4. The recovery check: after restoring healthy version `a4f9a86f`, three traffic cycles returned 15 successes and zero failures, confirming the version change (not a passing traffic spike) ended the incident.

## The operating principle

An automated responder earns a rollback the same way an engineer does: one failing request tied to one version, one named error, one affected population, and one verification that the fix worked. Error rates start the investigation. They never finish it.
