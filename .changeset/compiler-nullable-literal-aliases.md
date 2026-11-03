---
"@znight/compiler": patch
---

`NamedShape.literals` also lists the literals of an alias whose union holds `null` or `undefined` (`type Sort = 'title' | 'newest' | null` gives `['title', 'newest']`), so a nullable literal union keeps its source order.
