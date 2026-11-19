# Agent host unit tests

After each change, follow the fork's [commit and push rules](../../../../../../AGENTS.md#commit-and-push).

For tests in this area that touch the SessionDatabase, they MUST use an in-memory database, not a real database file on disk. Use `SessionDatabase.open(':memory:')` and see the examples from existing tests.
