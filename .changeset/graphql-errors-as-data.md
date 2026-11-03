---
"@znight/graphql": patch
---

Errors as data (RFC 0008): `resultMappers` turn the errors of guards, argument validation and resolvers into values of the field's union, on the fields whose union holds a type they declare (decided at boot, no cost for the other fields).
