// Signed test vectors for the HTTP destination contract v1 (docs/plans/2026-11-04-publish-destinations.md §3.1),
// shown on /docs/destinations and checked by test/destinations-docs.test.ts against the server's signer, so they
// can't drift: x-video-agent-signature = `t=<t>,v1=` + hex(HMAC-SHA256(secret, `${t}.${body}`)).
export const DESTINATION_VECTORS = [
  {
    secret: 'dsec_example_secret_do_not_use',
    t: 1793851200,
    body: '{"contract":1,"event":"ping","sentAt":"2026-11-05T06:00:00.000Z","destination":{"id":"dst_example","name":"Example"},"publisher":null}',
    signature: 't=1793851200,v1=0db259af6f8334771d231e68f830b828fdd6a9f375540ee233d0cd6d51883d7c',
  },
  {
    secret: 'dsec_example_secret_do_not_use',
    t: 1793851260,
    body: '{"contract":1,"event":"targets","sentAt":"2026-11-05T06:01:00.000Z","destination":{"id":"dst_example","name":"Example"},"publisher":{"id":"u_123"},"video":{"id":"vid_abc","title":"Launch"}}',
    signature: 't=1793851260,v1=9582e89a3ab3221e4174bae9a6d59705d63e49f936b9ca86a373ad1c1c0fcc20',
  },
] as const
