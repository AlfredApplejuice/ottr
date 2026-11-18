# Project Homepage Link

## Behavior

The project header shows a homepage link beside the GitHub repository link when GitHub has a usable homepage URL.

The link shows the existing external-link icon and the homepage domain. It opens in a new tab and sets `rel="noopener noreferrer"`.

Ottr reads the `homepage` field from `GET repos/{owner}/{repo}` through `gh api`. The response uses GitHub's repository object shape, where `homepage` is a root field.

The server refreshes this value with the existing project poll. `cachedRepoHomepage` shares requests and caches each result for ten minutes per repository. A page request does not call GitHub.

## Boundary and Errors

Accept only non-empty `http:` or `https:` URLs. Require a host. Reject user names and passwords in the URL.

Hide the link when GitHub returns no homepage or an invalid value. A failed GitHub request keeps the last valid value. A first failed request leaves the link hidden. The board remains available.

## API Contract

`ProjectHomepage` holds the normalized `url` and its `domain` from the parsed URL.

`ProjectView.homepage` and `TurnProject.homepage` hold a `ProjectHomepage` or `null`. The project view always returns this field. `TurnProject.homepage` can be unset before its first probe.
`parseRepoHomepage` reads the root `homepage` field. `repositoryHomepage` sends `GET repos/{owner}/{repo}` through `gh api`. `cachedRepoHomepage` keeps the last valid value after a request failure.

## Acceptance

- A GitHub repository response with a valid homepage returns its normalized URL and domain.
- The fetch uses `GET repos/{owner}/{repo}` and the documented repository response shape.
- Invalid, empty, missing, or unsafe homepage values return `null` without an exception.
- A project header with a homepage shows one external link with the right URL, domain, target, and `rel` value.
- A project header without a homepage shows no homepage link.
- A GitHub request failure does not block a board response and does not replace a last valid homepage.
- The link works with keyboard focus and the existing project header style.

## Non-goals

- Do not add a setting to edit or override the GitHub homepage.
- Do not add this link to other project views.
- Do not change the GitHub repository link or release and pull request links.
