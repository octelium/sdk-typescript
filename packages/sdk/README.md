# Octelium SDK NPM Package


This package exposes the Octelium client to interact with the _Cluster_ via its APIs. For example, you can use the client and control the _Cluster_ core API resources such as _Users_, _Services_, _ClusterConfig_, _Policies_, etc.


You can install it as follows:

```bash
npm install @octelium/sdk
```


Here is an example on how to use it with an [authentication token](https://octelium.com/docs/octelium/latest/management/core/credential#authentication-tokens):

```typescript
import { OcteliumClient } from "@octelium/sdk";

const c = await OcteliumClient.create({
  domain: "example.com",
  auth: {
    type: `authToken`,
    authToken: {
      token: `<AUTHENTICATION_TOKEN>`,
    },
  },
});

// Now access any core API method
let { response } = await c.coreV1.listUser({});
console.log(response.items.map((x) => x.metadata?.name));
```

Here is another example with [OAuth2 client credentials](https://octelium.com/docs/octelium/latest/management/core/credential#oauth2-client-credentials):


```typescript
import { OcteliumClient } from "@octelium/sdk";
import {GetOptions} from '@octelium/apis/main/metav1/metav1'

const c = await OcteliumClient.create({
  domain: "example.com",
  auth: {
    type: `oauth2ClientCredentials`,
    oauth2ClientCredentials: {
      clientId: `<CLIENT_ID>`,
      clientSecret: `<CLIENT_SECRET>`
    },
  },
});

let resp = await c.coreV1.getUser({
  name: 'john',
} as GetOptions);

let user = resp.response;
user.spec!.email = "john@example.com"
await c.coreV1.updateUser(user)
```