# Third-party notices

The all-rights-reserved notice for original ELYRA material does not replace,
restrict, or relicense third-party software. Third-party copyright remains with
the respective owners. Dependencies are installed by npm; node_modules and
production bundles are not included in this source snapshot.

Direct runtime dependencies:

| Package | Version | License | Copyright holder |
| --- | --- | --- | --- |
| react | 19.1.1 | MIT | Meta Platforms, Inc. and affiliates |
| react-dom | 19.1.1 | MIT | Meta Platforms, Inc. and affiliates |
| @heroicons/react | 2.2.0 | MIT | Tailwind Labs, Inc. |

The public source snapshot includes the installed runtime dependency license
texts in `docs/third-party-licenses/`. These texts are copied verbatim from
their installed npm packages, not replaced with the ELYRA notice.

Development tools and transitive dependencies retain their own licenses. The
complete locked package/version/license inventory is in
`docs/DEPENDENCY-LICENSES.json`; original notices are available in each package
installed by `npm ci`. Any binary redistribution must carry the applicable
third-party notices and comply with those dependencies' terms.
