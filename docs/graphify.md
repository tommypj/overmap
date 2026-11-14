---
type: doc
status: active
tags: [overmap, graphify]
relatedTo: []
---

# Graphify

Graphify turns a folder of code, notes and documents into a knowledge graph: communities of related files and symbols, and the links between them. Overmap shows that graph on the map, so you can zoom into a project and see its parts without opening the code.

Overmap does not run Graphify during a scan. It reads what Graphify has already written, and it only runs the `graphify` command for one thing: the Ask the graph box on a project.

## What Overmap reads

For each project, Overmap looks for `graphify-out/graph.json` inside the project's home folder. The file is in NetworkX node-link form:

- `nodes`: each with `id`, `label`, `community`, `community_name`, `source_file` and `file_type`. A node with no community is listed under "unassigned".
- `edges` (or `links`, which older files use): each with `source`, `target`, and optionally `relation`, `confidence` and `weight`.

Overmap computes the god nodes itself (the most connected nodes, by degree) because Graphify removes its own analysis file at the end of each run.

Files larger than `graphMaxBytes` in `overmap.config.json` (default 67108864, that is 64 MiB) are not loaded whole. The scan keeps only the summary: community sizes, god nodes and links between communities. The full node list is loaded when you zoom into a community.

When there is no graph file, the project shows "No graph yet" and the command to create one, `/graphify <project home>`.

## Producing a graph

Graphify is a Claude Code skill. In a Claude Code session, run:

```
/graphify <project home>
```

and it writes `graphify-out/graph.json` in that folder. Run it again after large changes; Overmap picks the new file up on the next scan.

## Ask the graph

On a project's zoomed-in view, the Ask the graph box runs this, and nothing else:

```
graphify query "<your question>"
```

It runs in the project's home folder, with the arguments passed directly and no shell, a 60-second limit, and a 500-character cap on the question. The request needs the same CSRF token and origin check as every other action, and each question is written to the audit log.

It needs `graphify` on your PATH. On Windows the command must be a real `.exe`. `.cmd` and `.bat` shims are not supported, because Windows runs them through the command interpreter, which would parse the question's characters as commands. If only a shim is installed, Overmap says so and asks you to install an `.exe`.

If your Graphify command has a different name or path, set `graphifyCommand` in `overmap.config.json`.
