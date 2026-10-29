# JWT capability authentication

`createJwtCapabilityAuthenticator` provides an opt-in authentication callback for `createCapabilityServer`. It accepts signed JWT access tokens conforming to the relevant [RFC 9068 validation requirements](https://www.rfc-editor.org/rfc/rfc9068.html), using RS256 and a host-configured local set of RSA public JWKs. It checks the exact HTTPS issuer, API audience, access-token `typ`, signature, key ID, expiry, issued-at time and maximum age, optional not-before time, subject, client ID and token ID. It rejects malformed or duplicate Authorization headers and does not accept ID tokens, symmetric algorithms or unsigned tokens. RSA keys must be 2048–4096 bits with exponent 65537; private key material is rejected.

```js
const authenticate = createJwtCapabilityAuthenticator({
  issuer: 'https://issuer.example/',
  audience: 'https://api.example/',
  jwks: trustedPublicJwks,
  maxTokenAgeSeconds: 600,
  resolveActor: claims => {
    // Apply host identity and scope policy to verified claims here.
    return lookupAuthorizedActor(claims);
  }
});
const server = createCapabilityServer(registry, authenticate, auditFailure);
```

The host must obtain the public keys from a trusted issuer through a secure, separately managed process and configure them only from trusted sources. Keys are snapshotted when the authenticator is constructed. A trusted host may call `authenticate.replaceKeys(newJwks)` to atomically replace the key set without restarting the server; malformed sets are rejected and leave the existing keys in place. Authentication still in progress is rejected if the set changes, even when the new set contains the same key. Call `authenticate.close()` to reject future and in-flight authentication; a closed authenticator cannot be reopened. Each server instance must receive its own update, and a request already authenticated before replacement may still be executing. This adapter does not perform issuer discovery, fetch JWKS, introspect or revoke individual tokens. Bearer tokens can be replayed until expiry; use TLS, protect tokens, choose a short maximum age, and apply network and request limits. A trusted, consistent clock is required. Optional clock tolerance is bounded to 60 seconds and extends acceptance around token time boundaries.

`resolveActor` receives a copy of verified claims and must map the issuer's subject, tenant and scopes using host policy; claims or token contents do not automatically grant a capability. It may return `undefined` to deny access. The adapter checks token time again after an asynchronous mapping. The capability registry separately authorizes every invocation and audits attempts; hosts must provide durable audit and account for policy changes during a request. Token expiry or revocation after authentication is not atomic with downstream execution. The capability server does not itself provide HTTPS, browser session security, authorization-server availability, tenant provisioning or production deployment.
