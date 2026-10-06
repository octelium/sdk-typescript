# Core API examples

These scripts use the generated Core API directly to manage Cluster resources. Each script supports `--help`. Listing follows every page; updates retrieve the full existing resource and change only the selected fields, preserving other metadata and specification settings.

| Script              | Operations                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `users.ts`          | List, get, create human/workload Users, update email/groups, disable/enable, delete                     |
| `services.ts`       | List/filter by Namespace, get, create HTTP Services, change upstream/Policies, disable/enable, delete   |
| `policies.ts`       | List, get, create CEL Policies, edit a named rule, disable/enable, delete                               |
| `credentials.ts`    | List/filter by User, get, create clientless Credentials, generate/rotate tokens, disable/enable, delete |
| `cluster-config.ts` | Read ClusterConfig and update human/workload session limits                                             |

From the repository root:

```sh
npm ci
npm run build
export OCTELIUM_DOMAIN=example.com
export OCTELIUM_ACCESS_TOKEN='<administrator access token>'
cd packages/sdk/examples
```

Run with `npx --yes tsx <script> ...`. The commands below use an existing administrator access token so separate CLI processes do not reuse a one-use authentication token. The identity needs Core API permissions and an `api:core` scope or applicable method scopes. See the [SDK authentication guide](../README.md) for managed sessions, assertions and OAuth credentials in applications that reuse a client.

## Provision a CI workload and its HTTP Service

This sequence creates a workload User, limits Service access to that User with a CEL Policy, attaches the Policy to an HTTP Service, and creates a clientless authentication credential. `default` is an existing Namespace; the upstream is a backend reachable from the Cluster.

```sh
npx --yes tsx users.ts create ci-agent --type workload
npx --yes tsx policies.ts create reports-access \
  --match 'ctx.user.metadata.name == "ci-agent"'
npx --yes tsx services.ts create reports.default \
  --upstream http://reports.analytics.svc.cluster.local:8080 \
  --policies reports-access --public
npx --yes tsx credentials.ts create ci-agent-token \
  --user ci-agent --type auth-token --expires-hours 24
npx --yes tsx credentials.ts token ci-agent-token
```

`--public` enables HTTPS clientless access; the Service still requires authentication and evaluates its attached Policy. It does not enable anonymous access. Creating a Credential returns its resource, not its secret. The separate `token` command prints the generated secret; store it in your CI secret store. Running `token` again rotates the credential and invalidates its previous token.

Authentication credentials in this example permit one initial authentication. A long-lived SDK client subsequently refreshes the managed session using its refresh token.

Inspect resources, move to a new backend, and disable the workload:

```sh
npx --yes tsx users.ts list
npx --yes tsx services.ts list --namespace default
npx --yes tsx policies.ts get reports-access
npx --yes tsx credentials.ts list --user ci-agent
npx --yes tsx services.ts update reports.default \
  --upstream http://reports-v2.analytics.svc.cluster.local:8080
npx --yes tsx users.ts update ci-agent --disabled
```

Remove the created resources when finished:

```sh
npx --yes tsx credentials.ts delete ci-agent-token
npx --yes tsx services.ts delete reports.default
npx --yes tsx policies.ts delete reports-access
npx --yes tsx users.ts delete ci-agent
```

## Manage human Users and group membership

```sh
npx --yes tsx users.ts create alice --type human --email alice@example.com
npx --yes tsx users.ts get alice
npx --yes tsx users.ts update alice --email alice.smith@example.com
npx --yes tsx users.ts update alice --groups engineering,operators
npx --yes tsx users.ts update alice --groups ''
npx --yes tsx users.ts update alice --disabled
npx --yes tsx users.ts update alice --enabled
npx --yes tsx users.ts delete alice
```

Group names must already exist. `--groups` replaces membership; an empty string clears it. Email is supported for human Users. Creating a User does not configure a password or an identity provider.

## Update access Policies

For the existing `reports-access` Policy:

```sh
npx --yes tsx policies.ts list
npx --yes tsx policies.ts update reports-access --rule allow-access \
  --match 'ctx.user.metadata.name == "release-agent"'
npx --yes tsx policies.ts update reports-access --rule allow-access --effect deny
npx --yes tsx policies.ts update reports-access --disabled
npx --yes tsx policies.ts update reports-access --enabled
```

A named rule must already exist; editing it preserves other rules, enforcement rules and attributes. A standalone Policy takes effect when attached to a resource. Detach references and dependent child Policies before deleting it.

## Issue OAuth2 and access-token Credentials

For an existing workload User:

```sh
npx --yes tsx credentials.ts create ci-oauth --user ci-agent --type oauth2 --expires-hours 24
npx --yes tsx credentials.ts token ci-oauth
npx --yes tsx credentials.ts create ci-access --user ci-agent --type access-token --expires-hours 24
npx --yes tsx credentials.ts token ci-access
npx --yes tsx credentials.ts update ci-access --disabled
npx --yes tsx credentials.ts update ci-access --enabled
npx --yes tsx credentials.ts delete ci-access
npx --yes tsx credentials.ts delete ci-oauth
```

OAuth2 and access-token credentials require a workload User. Unlike the one-use authentication credential example, their `maxAuthentications` is zero, allowing repeated authentication until expiry, revocation or rotation. Credential lifetimes are between 1 and 17,520 hours in these examples. The server enforces applicable authorization settings.

## Manage ClusterConfig

```sh
npx --yes tsx cluster-config.ts get
npx --yes tsx cluster-config.ts update --human-max-sessions 5 --workload-max-sessions 25
npx --yes tsx cluster-config.ts update --workload-max-sessions 50
```

Limits must be between 1 and 1,000. Updating only the workload limit preserves human session settings and other ClusterConfig sections.

Each RPC has a 10-second timeout. SDK clients close in `finally`, and API errors propagate. Get/modify/update is not an atomic patch; coordinate concurrent writers. The scripts do not retry creates, silently ignore failed deletes or clear unrelated fields.
