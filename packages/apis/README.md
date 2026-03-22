# Octelium APIs NPM Package


This package exposes the Octelium APIs compiled to Typescript from proto3.


You can install it as follows:

```bash
npm install @octelium/apis
```




Here is an example when used by the Octelium SDK client:

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