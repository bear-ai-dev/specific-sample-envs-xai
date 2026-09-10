# Arcade settings

Arcade preferences live in `~/.gamepigeon/settings.json`, written atomically with owner-only permissions. Changes take effect immediately; hook behavior is read on the next prompt, stop, or session start.

The Settings screen controls automatic open/pause/reset behavior, agent break suggestions and snoozing, window size, resume behavior, scores, cloud gameplay sync, product analytics, and local recording.

Turning off cloud sync keeps recordings in the local queue. Turning off recording stops new gameplay traces; existing local traces are preserved. Turning off analytics disables both direct PostHog capture and queued analytics.

Future settings: per-game remaps, themes, notification sounds, multiplayer defaults, and local trace export.
