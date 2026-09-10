# Gameplay ingestion contracts

These files are the stable handoff from the TypeScript arcade client to the future backend repository.

The client owns event creation, local durability, immutable chunk construction, recovery, retry behavior, and exact acknowledgment matching. A successful chunk acknowledgment reports `queued: true` once the chunk is durably handed to the backend queue; it carries no broker partition or offset. The ingestion service, authentication, score database, and backend workers are implemented in the backend repository.

Envelope invariants that implementations must additionally enforce:

- `event_count` equals `events.length`;
- event sequences are strictly increasing;
- schema-v2 event `user_id`, `game_id`, and `chunk_id` values match their chunk;
- `first_event_sequence` and `last_event_sequence` match the enclosed events;
- `(game_id, chunk_id)` and `(game_id, chunk_sequence)` identify one immutable payload;
- successful acknowledgment must match the game, chunk, chunk sequence, and accepted event range.

The v1 and v2 fixtures are backend-neutral and can be consumed by future backend contract tests.

Overlay sessions use schema v2 with `episode_started.payload.platform` set to
`overlay`, `input_semantics` set to `engine_impulse`, and policy observations
represented as `{ representation: "engine_state_v1", state }`. The native
client envelope remains `client.platform: "tui"` for compatibility with the
deployed ingestion validator.
