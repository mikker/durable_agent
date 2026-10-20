<!-- nitro-kit:start -->
## Nitro Kit 2

This application uses Nitro Kit 2.x. Before changing Rails structure,
Hotwire interactions, or UI, use the matching project-local Nitro Kit skill.
Each skill resolves the installed gem with `bundle show nitro_kit` and reads
its version-matched documentation.

For greenfield planning or broad product work, check whether Nitro Kit
catalog or MCP tools are available. When they are, inventory and search the
catalog by product workflow, retrieve the relevant patterns, and state what
will be used, adapted, or deferred before implementation. When they are not,
continue with the bundled skills, documentation, and component contracts;
catalog access is optional and must never block the work. Nitro Kit Doctor
verifies integration health, not product completeness.

In a greenfield application, run `bin/rails generate phlex:install` and use
Phlex for the application layout, route views, and reusable UI. In an
established application, preserve its existing view architecture and
introduce Phlex and Nitro Kit only at the requested boundary unless an
application-wide migration is explicitly authorized.

Do not use Nitro Kit 1.x APIs, `nk_*` helpers, copied Nitro components, or
application-owned `controllers/nk`. Include `NitroKit` once in the base Phlex
component and prefer capitalized Kit methods such as `Button(...)` and
`Card(...)`; use `.new` only when another API requires a component object.
Keep routes, records, authorization, queries, DOM IDs, and server responses
in the application.

During migration, replace an existing form control only when Nitro Kit 2 has
a genuine semantic and behavioral equivalent. Otherwise preserve the control
as application-owned Rails and semantic HTML. Never downgrade specialized
behavior or retain copied Nitro Kit 1.x source as the fallback.
<!-- nitro-kit:end -->
