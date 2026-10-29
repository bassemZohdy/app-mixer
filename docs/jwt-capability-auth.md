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

The host must obtain the public keys from a trusted issuer through a secure, separately managed process and configure them only from trusted sources. Keys are snapshotted when the authenticator is constructed. A trusted host may call `authenticate.replaceKeys(newJwks)` to atomically replace the key set without restarting the server; malformed sets are rejected and leave the existing keys in place. Authentication still in progress is rejected if the set changes, even when the new set contains the same key. Call `authenticate.close()` to reject future and in-flight authentication; a closed authenticator cannot be reopened. Each server instance must receive its own update, and a request already authenticated before replacement may still be executing. The authenticator does not perform issuer discovery or introspect tokens. Optional JWKS refresh and individual token checks are described below. Bearer tokens can be replayed until expiry; use TLS, protect tokens, choose a short maximum age, and apply network and request limits. A trusted, consistent clock is required. Optional clock tolerance is bounded to 60 seconds and extends acceptance around token time boundaries.

`resolveActor` receives a copy of verified claims and must map the issuer's subject, tenant and scopes using host policy; claims or token contents do not automatically grant a capability. It may return `undefined` to deny access. The adapter checks token time again after an asynchronous mapping. The capability registry separately authorizes every invocation and audits attempts; hosts must provide durable audit and account for policy changes during a request. Token expiry or revocation after authentication is not atomic with downstream execution. The capability server does not itself provide HTTPS, browser session security, authorization-server availability, tenant provisioning or production deployment.


## Optional JWKS refresh

`JwtJwksManager` can refresh a host-configured JWKS URL and expose an `authenticate` callback for `createCapabilityServer`. Configure it with the authenticator, a trusted `jwksUrl`, `pollMs`, `maxStaleMs`, `timeoutMs` and `onError`. Call `start()` to begin polling, or `await refresh()` for an explicit refresh. The manager denies authentication until a refresh succeeds and whenever the last successful refresh is `maxStaleMs` old. It rejects redirects, non-JSON responses, private key material, malformed key metadata or eligible RSA keys, and responses above 128 KiB. From a mixed public JWKS it selects RSA keys eligible for RS256 signature verification and ignores keys for other algorithms or encryption. At least one eligible key must remain, and every selected key must meet the authenticator's restrictions. A failed refresh retains the previous keys only until the stale deadline. Identical responses refresh the deadline without invalidating in-flight requests; changed keys fence them. An authentication that spans its original stale deadline is rejected even if a later refresh succeeds.

The URL must use HTTPS with normal platform certificate validation; `allowLoopbackHttp: true` permits loopback HTTP for local development only. The host must configure and protect the issuer-to-JWKS binding, control DNS and outbound network access, and avoid using untrusted URLs. The manager does not perform OIDC discovery or dynamically trust a URL from a token. Use `manager.authenticate` for all requests and do not independently replace the underlying authenticator's keys while it is managed. `stop()` stops polling and aborts an in-flight refresh; previously fetched keys remain usable only until their stale deadline. `close()` also closes the underlying authenticator. Each process needs its own manager, and key removal is not instantaneous during refresh outages: set the stale limit to the acceptable maximum revocation delay.

## Optional token revocation

A host may provide `isTokenActive: claims => ...` to the authenticator. It receives a copy of verified claims after identity mapping; only `true` permits authentication. Errors and other results deny access. The token's time and key set are checked again after the callback. This callback is optional, and a remote or asynchronous status check is not atomic with later capability execution.

`SqliteJwtRevocations` is an optional local implementation scoped to one exact issuer. A trusted administrative host can call `revoke(jti, retainUntil)` with a UTC millisecond retention deadline, and connect `isTokenActive: claims => revocations.isTokenActive(claims)` to the authenticator. The store hashes the token ID, retains the longest deadline on repeated revocations, and denies recorded IDs until explicitly pruned. It does not store bearer tokens. The host must authenticate and authorize revocation operations, obtain token IDs from trusted verified data, secure the database and backups, and ensure the issuer does not reuse a token ID for another still-relevant token.

Choose `retainUntil` to cover the token's full possible acceptance window, including all configured clock tolerance, every server's maximum token age and any clock skew. `prune(cutoff, limit)` deletes a bounded batch only up to the local current time; pruning too early can make a still-valid token usable again. Use consistent clocks and retain revocations longer when in doubt. A local SQLite file coordinates only hosts sharing that database; distributed revocation and notification are not provided. A request that has already passed authentication can still execute after revocation, so enforce stricter transactional policy at the protected operation when required.
