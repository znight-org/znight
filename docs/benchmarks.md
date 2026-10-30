---
title: Benchmarks
pageClass: zn-benchmarks
description: Cold start, memory, dependency injection and HTTP throughput of Znight against NestJS, tsyringe, InversifyJS and hand-wired Fastify, Express, Hono and node:http servers, with the method and the commands to reproduce every number.
---

# Benchmarks

<BenchmarkHighlights />

Znight solves the dependency graph when you build, not when you boot. These benchmarks measure
what that changes at runtime, against NestJS, the closest framework, against the runtime containers
tsyringe and InversifyJS, and against the same application wired by hand on each HTTP server. Every
number on this page comes from
[`benchmarks/results/results.json`](../benchmarks/results/results.json), produced by the scripts of
[`benchmarks/`](../benchmarks/README.md): run them on your machine to check them.

## Summary

<!-- benchmarks:summary -->

- **2.0× faster cold start than NestJS**: 150 ms vs 302 ms to the first response.
- **26% less memory than NestJS**: 89 MiB vs 122 MiB resident at idle.
- **3.4× faster DI container than NestJS**: 11 ms vs 36 ms to create 1,000 providers.
- **Throughput: Znight is behind NestJS on Node.js** with Fastify: 114,237 requests per second for `GET /users/:id`, against 127,025 for NestJS and 149,999 for hand-wired Fastify, about 1 µs more per request (see [Throughput](#throughput-and-latency)).

<!-- /benchmarks:summary -->

Znight starts up to twice as fast as the same NestJS application and uses less memory, because
there is less to load and less to do at boot. Under load, it is close to NestJS: ahead of it on
Express, about a microsecond per request behind it on Fastify. Its request pipeline does more per
request than the hand-wired servers, which matters for services that answer in microseconds and much
less for those that wait for a database.

## What is measured

### The application

Every framework serves the same small API, written the way its documentation recommends: a
controller, a service and a repository (an in-memory map of 1,000 users), two routes, JSON.

| Route            | What happens                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `GET /users/:id` | The id is parsed as an integer, the user read through the service and sent as JSON         |
| `POST /users`    | The JSON body is validated with the same Zod 4 schema, a user created, `201` and JSON sent |

| Application | Code                                                                                                               | Built with                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Znight      | [`apps/znight`](../benchmarks/apps/znight/src): `@Controller`, `@Injectable`, `@Body(CreateUser)`                  | `znight build` (Vite, decorators stripped)            |
| NestJS 12   | [`apps/nestjs`](../benchmarks/apps/nestjs/src): two modules, `ParseIntPipe`, the built-in Standard Schema pipe     | `tsc` with `emitDecoratorMetadata`, like `nest build` |
| Hand-wired  | [`apps/baseline`](../benchmarks/apps/baseline/src): the same classes created with `new`, routes registered by hand | `tsc`                                                 |

The hand-wired servers are the floor: the cost of the HTTP server itself, with no framework on top.
Each framework runs with its defaults, which do not do the same work per request: Znight adds a
request id and four security headers to every response, Express adds an ETag and `x-powered-by`.
NestJS runs with `logger: false`, so that it does not log while the others stay silent. Every
application runs the same build on Node.js and on Bun, with `NODE_ENV=production`.

### Environment

<!-- benchmarks:environment -->

| Setup            |                        Value |
| ---------------- | ---------------------------: |
| CPU              |           Apple M5, 10 cores |
| Memory           |                       16 GiB |
| Operating system |                 macOS 26.6.2 |
| Runtimes         |   Node.js 24.21.0, Bun 1.4.4 |
| Measured         | 2026-10-30, commit `67d1ade` |

| Package                    | Version |
| -------------------------- | ------: |
| `@znight/core`             |   0.1.1 |
| `@znight/http`             |   0.1.1 |
| `@znight/compiler`         |   0.1.1 |
| `@nestjs/core`             |  12.3.2 |
| `@nestjs/platform-fastify` |  12.3.2 |
| `@nestjs/platform-express` |  12.3.2 |
| `fastify`                  |  5.12.7 |
| `express`                  |   5.3.0 |
| `hono`                     | 4.13.14 |
| `@hono/node-server`        |   2.1.5 |
| `zod`                      |   4.6.7 |
| `tsyringe`                 |  4.10.0 |
| `inversify`                |   8.2.3 |
| `reflect-metadata`         |   0.2.2 |
| `autocannon`               |   8.0.0 |
| `typescript`               |   7.0.2 |
| `vite`                     |   8.3.5 |

<!-- /benchmarks:environment -->

## Cold start and memory

How long it takes from starting the process to answering a request: what a deployment, an autoscaler
or a serverless platform waits for. The runner spawns `node dist/main.js` (or `bun dist/main.js`),
requests `GET /users/1` every millisecond until it gets a `200`, and records the elapsed time: the
runtime start, the imports, the application bootstrap and the first request. It then samples the
resident memory of the idle process. Each application is started once before the measured runs (so
the file system cache is warm for all), then the applications take turns, in a different order on
each run.

<!-- benchmarks:boot -->

![Cold start of each application on Node.js and Bun, in milliseconds](/benchmarks/boot.svg)

![Resident memory of each application at idle on Node.js and Bun, in MiB](/benchmarks/memory.svg)

| Application            |                    Node.js: start |                 Node.js: memory |                        Bun: start |                     Bun: memory |
| ---------------------- | --------------------------------: | ------------------------------: | --------------------------------: | ------------------------------: |
| Hand-wired (Fastify)   |     132 ms <small>125–140</small> |     83 MiB <small>83–84</small> |     114 ms <small>103–123</small> |     48 MiB <small>48–49</small> |
| **Znight (Fastify)**   | **150 ms** <small>142–160</small> | **89 MiB** <small>89–89</small> | **113 ms** <small>108–123</small> | **54 MiB** <small>54–54</small> |
| NestJS (Fastify)       |     302 ms <small>291–320</small> |  122 MiB <small>111–122</small> |     243 ms <small>226–295</small> |     80 MiB <small>79–81</small> |
| Hand-wired (Express)   |     112 ms <small>108–121</small> |     75 MiB <small>74–76</small> |        88 ms <small>83–90</small> |     48 MiB <small>47–48</small> |
| **Znight (Express)**   | **138 ms** <small>132–143</small> | **89 MiB** <small>88–89</small> |  **108 ms** <small>97–121</small> | **50 MiB** <small>49–50</small> |
| NestJS (Express)       |     251 ms <small>241–265</small> |  110 MiB <small>110–110</small> |     166 ms <small>157–170</small> |     68 MiB <small>68–69</small> |
| Hand-wired (node:http) |        88 ms <small>83–90</small> |     75 MiB <small>75–75</small> |        45 ms <small>41–48</small> |     34 MiB <small>34–34</small> |
| **Znight (node:http)** |   **99 ms** <small>95–106</small> | **79 MiB** <small>78–80</small> |    **61 ms** <small>52–65</small> | **39 MiB** <small>39–40</small> |
| Hand-wired (Hono)      |       96 ms <small>89–101</small> |     80 MiB <small>80–80</small> |        34 ms <small>30–38</small> |     32 MiB <small>31–32</small> |
| **Znight (Hono)**      | **107 ms** <small>103–120</small> | **81 MiB** <small>81–82</small> |    **62 ms** <small>58–68</small> | **40 MiB** <small>40–40</small> |

Median of 30 starts, with the interquartile range (25th to 75th percentile) in small type. Memory is sampled 500 ms after the first response.

<!-- /benchmarks:boot -->

On both runtimes and with both adapters, a Znight application is ready in half to two thirds of the
time of the same NestJS application, and uses less memory. A NestJS application loads `reflect-metadata`,
discovers its modules, reads the decorator metadata of every class and resolves the graph on every
boot; a Znight application imports a generated module and calls its factories in an order computed
at build time. What separates Znight from the hand-wired servers, at most a few tens of milliseconds,
is loading `@znight/core` and `@znight/http`, building the route table and creating the providers.

## Throughput and latency

Requests per second under load: [autocannon](https://github.com/mcollina/autocannon), run by
Node.js in its own process, keeps 100 connections busy on one route. For each round, every
application is started, warmed up on the route, measured, then stopped; the rounds change the order
of the applications.

<!-- benchmarks:http -->

#### `GET /users/:id`

![Requests per second of each application for GET /users/:id, on Node.js and Bun](/benchmarks/throughput-get.svg)

| Application            |                        Node.js: requests/s | Node.js: p99 |                            Bun: requests/s | Bun: p99 |
| ---------------------- | -----------------------------------------: | -----------: | -----------------------------------------: | -------: |
| Hand-wired (Fastify)   |     149,999 <small>144,143–150,057</small> |         1 ms |     164,823 <small>157,213–165,510</small> |     1 ms |
| **Znight (Fastify)**   | **114,237** <small>113,990–115,401</small> |         1 ms | **117,711** <small>103,315–126,490</small> |     1 ms |
| NestJS (Fastify)       |     127,025 <small>122,836–129,969</small> |         1 ms |     129,728 <small>126,269–136,873</small> |     1 ms |
| Hand-wired (Express)   |        92,529 <small>90,010–93,158</small> |         2 ms |     124,268 <small>113,271–135,581</small> |     1 ms |
| **Znight (Express)**   |    **98,982** <small>95,695–99,552</small> |         1 ms | **117,187** <small>116,698–119,537</small> |     1 ms |
| NestJS (Express)       |        84,855 <small>82,313–85,356</small> |         2 ms |     118,112 <small>113,830–125,716</small> |     1 ms |
| Hand-wired (node:http) |     148,637 <small>142,807–150,662</small> |         1 ms |     167,475 <small>157,492–174,714</small> |     1 ms |
| **Znight (node:http)** | **121,807** <small>121,079–122,063</small> |         1 ms | **136,108** <small>121,824–136,666</small> |     1 ms |
| Hand-wired (Hono)      |     143,552 <small>136,047–143,855</small> |         1 ms |     175,447 <small>172,876–178,298</small> |     1 ms |
| **Znight (Hono)**      | **101,402** <small>101,117–103,596</small> |         1 ms | **135,930** <small>126,170–136,035</small> |     1 ms |

#### `POST /users` (validated body)

![Requests per second of each application for POST /users (validated body), on Node.js and Bun](/benchmarks/throughput-post.svg)

| Application            |                     Node.js: requests/s | Node.js: p99 |                            Bun: requests/s | Bun: p99 |
| ---------------------- | --------------------------------------: | -----------: | -----------------------------------------: | -------: |
| Hand-wired (Fastify)   |  123,633 <small>122,836–123,889</small> |         1 ms |     134,313 <small>129,638–135,744</small> |     1 ms |
| **Znight (Fastify)**   | **87,747** <small>85,414–88,579</small> |         2 ms |   **93,984** <small>91,087–101,553</small> |     1 ms |
| NestJS (Fastify)       |   100,474 <small>98,458–104,058</small> |         1 ms |     106,412 <small>100,559–113,329</small> |     1 ms |
| Hand-wired (Express)   |     77,344 <small>76,599–78,042</small> |         2 ms |       99,180 <small>99,104–104,207</small> |     1 ms |
| **Znight (Express)**   | **82,860** <small>80,823–84,250</small> |         2 ms |   **99,884** <small>99,348–108,890</small> |     1 ms |
| NestJS (Express)       |     69,056 <small>65,500–69,169</small> |         2 ms |        94,956 <small>86,880–95,631</small> |     1 ms |
| Hand-wired (node:http) |  129,597 <small>128,771–130,621</small> |         1 ms |     149,370 <small>138,572–150,243</small> |     1 ms |
| **Znight (node:http)** | **97,030** <small>96,637–98,447</small> |         1 ms | **115,692** <small>100,297–116,698</small> |     1 ms |
| Hand-wired (Hono)      |  111,852 <small>108,815–112,416</small> |         1 ms |     170,013 <small>157,993–170,816</small> |     1 ms |
| **Znight (Hono)**      | **86,758** <small>85,530–88,265</small> |         2 ms |    **59,891** <small>57,910–60,237</small> |     3 ms |

Median of 3 rounds of 10 seconds (minimum–maximum in small type), each after a 3-second warm-up, 100 connections, no pipelining. Latency: the 99th percentile reported by autocannon, which records whole milliseconds.

<!-- /benchmarks:http -->

Under load, Znight is close to NestJS and below the hand-wired servers. On Node.js it serves more
requests per second than NestJS on Express (and than the hand-wired Express application, whose
`res.json()` it does not use), and 10% to 13% fewer on Fastify: one to one and a half microseconds
per request. On Bun it is level with NestJS on Express and behind it on Fastify. The servers are the
same, so the difference with the hand-wired servers is Znight's request pipeline: for every request
it opens a request scope, generates a request id, writes its security headers, and serializes the
response itself before handing it to the server. One result stands apart: `POST` with Hono on Bun,
where the body is read through a Web stream, is far below the hand-wired Hono application. These
microseconds matter for services that answer from memory; for a service whose requests wait for a
database or another service, they are rarely what limits throughput.

## Dependency injection

The container alone, without HTTP. A generated project of _N_ provider classes, one module each, in
10 layers: each provider takes three providers of the layer below in its constructor. Each framework
gets the same classes with its own decorator, and an entry that imports them, creates the container
and instantiates every provider (NestJS: `createApplicationContext()` of a module listing them all;
tsyringe and InversifyJS: one singleton registration per class, then one resolution per class). All
projects, Znight's included, are compiled by `tsc` to one module per class, so that loading the
modules costs the same everywhere.

<!-- benchmarks:di -->

![Time to create the container and every provider, for 100 and 1,000 providers, on Node.js and Bun](/benchmarks/di.svg)

**Container creation**: the container is created and every provider instantiated, measured inside the process once every module is imported.

| Container   |                      Node.js: 100 |                  Node.js: 1,000 |                          Bun: 100 |                     Bun: 1,000 |
| ----------- | --------------------------------: | ------------------------------: | --------------------------------: | -----------------------------: |
| **Znight**  | **1.8 ms** <small>1.7–2.0</small> | **11 ms** <small>9.8–13</small> | **2.2 ms** <small>2.0–3.1</small> | **11 ms** <small>10–14</small> |
| tsyringe    |     1.0 ms <small>0.9–1.1</small> |   5.9 ms <small>5.5–6.4</small> |     1.1 ms <small>1.1–1.3</small> |  6.7 ms <small>6.0–8.9</small> |
| InversifyJS |     3.4 ms <small>3.1–3.9</small> |      15 ms <small>14–18</small> |     3.9 ms <small>3.2–5.1</small> |     16 ms <small>14–20</small> |
| NestJS      |     7.0 ms <small>6.6–8.1</small> |      36 ms <small>34–43</small> |       11 ms <small>9.9–14</small> |     36 ms <small>34–52</small> |

**Whole process**: spawned to exit, including the runtime start and the imports of the framework and of every provider module.

| Container   |                   Node.js: 100 |                    Node.js: 1,000 |                       Bun: 100 |                     Bun: 1,000 |
| ----------- | -----------------------------: | --------------------------------: | -----------------------------: | -----------------------------: |
| **Znight**  | **45 ms** <small>42–55</small> | **171 ms** <small>163–249</small> | **39 ms** <small>35–41</small> | **82 ms** <small>77–91</small> |
| tsyringe    |     58 ms <small>52–72</small> |     230 ms <small>223–277</small> |     23 ms <small>22–29</small> |   104 ms <small>94–119</small> |
| InversifyJS |    83 ms <small>78–107</small> |     259 ms <small>240–316</small> |     46 ms <small>42–52</small> |  163 ms <small>158–175</small> |
| NestJS      |  157 ms <small>142–192</small> |     335 ms <small>323–456</small> |  107 ms <small>104–133</small> |  222 ms <small>210–263</small> |

Median of 30 processes, with the interquartile range in small type.

**Build-time cost**: what Znight moves to the build. The compiler (`generate()`, the work of `znight generate` and of the Vite plugin) scans, parses, analyses, binds and validates the providers and writes the container module, in a fresh Node.js process:

| Providers |       `generate()` on Node.js |
| --------- | ----------------------------: |
| 100       |    82 ms <small>73–96</small> |
| 1,000     | 637 ms <small>548–664</small> |

<!-- /benchmarks:di -->

Znight's container is created three to five times faster than NestJS's, and faster than
InversifyJS's. tsyringe creates its providers faster still: it only resolves constructors, while
Znight's container also checks the generated metadata, records every instance for the shutdown and
applies method interceptors, and each generated factory runs once, compiled on its first call. Over
the whole process, which is what a boot costs, Znight is the fastest on Node.js at both sizes, and
on Bun with 1,000 providers (tsyringe is faster with 100): it loads neither `reflect-metadata` nor
decorator metadata, and its decorators do nothing at runtime. The analysis moves to the build, where
generating the container takes a fraction of a second, once per build (incrementally in watch mode).

## Caveats

- **A laptop, not a lab.** The machine also ran a desktop session. Rounds are interleaved so that
  noise spreads over every application, and the spread is published, but absolute numbers will
  differ on your hardware: compare the applications with each other, on the same machine.
- **Load generator on the same machine.** autocannon shares the CPU with the server. The fastest
  hand-wired servers may be limited by it; the framework applications, slower, are not. A dedicated
  client machine would give higher numbers for everyone. autocannon records latencies in whole
  milliseconds, so this page shows their 99th percentile only.
- **Noise.** Differences of about 10% or less, or within the ranges shown, are not significant on
  this machine.
- **Small, synthetic workloads.** The routes do no I/O: they measure the framework, not your
  database. In most services, the time spent in the database, the network and your own code is
  larger than any difference shown here.
- **Defaults, not tuning.** No framework is tuned beyond turning NestJS's logger off. In particular,
  Znight's security headers and request ids are on, as they are in your application by default.
- **Dependency injection projects are compiled with `tsc`.** A Znight application is normally built
  by Vite, which bundles the provider modules and strips the decorators: the dependency injection
  suite does not use that advantage.

## Reproduce

The benchmarks are a workspace of the repository, [`benchmarks/`](../benchmarks/README.md). They are
not run by the continuous integration: run them on your machine (about 40 minutes for everything).

```sh
git clone https://github.com/znight-org/znight.git
cd znight
bun install
bun run build                       # the @znight/* packages, used by the Znight application

cd benchmarks
bun run bench                       # builds the applications, then every suite
bun run report                      # the charts and the tables of this page, from the results
```

`bun run bench:boot`, `bench:http` and `bench:di` run one suite; `bun src/cli.ts http --runtimes node
--variants znight-fastify,nestjs-fastify` restricts a run; `--quick` checks the setup in a few
minutes (its results go to `results/quick.json`). The
[benchmarks README](../benchmarks/README.md) describes the layout and how to add a framework.
