# Review output examples

These are wording examples of the historical [PR42 crawler finding](https://github.com/frostney/slop-sheriff/pull/42#discussion_r3984696250), rendered with the shared comment formatter. The issue was subsequently fixed. Presets change wording, not evidence or severity. These samples are not runtime phrase templates.

## Theatrical cowboy robot (default)

### Inline comment

<!-- known-good-review:finding:v2:437eead14b5f587f17f629528fc7ede659f54906e60cc586551642286efd4da2:CR-2 -->
### ⚠️ Do not block crawlers from seeing the alias noindex directive

**Important**

Well, my circuits found a standoff: robots\.txt blocks crawlers from reading the alias’s noindex directive\. Both controls look sensible alone, partner, but together they prevent the indexing rule from doing its job\.

<details>
<summary>Evidence and recommended change</summary>

A production\-alias probe returned `robots.txt` Disallow: / alongside HTML and X\-Robots\-Tag noindex directives\.

Google requires crawler access to discover and honor a noindex directive\.

Allow crawling on public aliases while returning noindex, or permanently redirect production aliases to the canonical origin\.

</details>

Impact: A production alias can appear as a URL\-only search result because robots\.txt blocks crawlers from seeing noindex, weakening canonical\-host\-only indexing\.

Risk: Linked alias URLs can appear in search results while crawlers remain unable to read noindex\.

### Main comment

## 🛑 Slop Sheriff: changes needed

1 finding requires changes.

Hold your horses, partner\. My crawler checks found robots\.txt blocking the noindex directive on public aliases\. Allow those URLs to be crawled while retaining noindex, or redirect them to the canonical host\.


## Understated cowboy robot

### Inline comment

<!-- known-good-review:finding:v2:437eead14b5f587f17f629528fc7ede659f54906e60cc586551642286efd4da2:CR-2 -->
### ⚠️ Do not block crawlers from seeing the alias noindex directive

**Important**

Hold up, partner\. robots\.txt blocks crawlers from reading the alias’s noindex directive\. The indexing control depends on crawler access, so these two settings work against each other on public aliases\.

<details>
<summary>Evidence and recommended change</summary>

A production\-alias probe returned `robots.txt` Disallow: / alongside HTML and X\-Robots\-Tag noindex directives\.

Google requires crawler access to discover and honor a noindex directive\.

Allow crawling on public aliases while returning noindex, or permanently redirect production aliases to the canonical origin\.

</details>

Impact: A production alias can appear as a URL\-only search result because robots\.txt blocks crawlers from seeing noindex, weakening canonical\-host\-only indexing\.

Risk: Linked alias URLs can appear in search results while crawlers remain unable to read noindex\.

### Main comment

## 🛑 Slop Sheriff: changes needed

1 finding requires changes.

One issue needs attention, partner: allow crawlers to read noindex on public aliases, or redirect those aliases to the canonical host\.


## Personality off

### Inline comment

<!-- known-good-review:finding:v2:437eead14b5f587f17f629528fc7ede659f54906e60cc586551642286efd4da2:CR-2 -->
### ⚠️ Do not block crawlers from seeing the alias noindex directive

**Important**

robots\.txt blocks crawlers from reading the alias’s noindex directive\. Because the indexing control depends on crawler access, the current combination can leave publicly linked alias URLs eligible to appear in search results\.

<details>
<summary>Evidence and recommended change</summary>

A production\-alias probe returned `robots.txt` Disallow: / alongside HTML and X\-Robots\-Tag noindex directives\.

Google requires crawler access to discover and honor a noindex directive\.

Allow crawling on public aliases while returning noindex, or permanently redirect production aliases to the canonical origin\.

</details>

Impact: A production alias can appear as a URL\-only search result because robots\.txt blocks crawlers from seeing noindex, weakening canonical\-host\-only indexing\.

Risk: Linked alias URLs can appear in search results while crawlers remain unable to read noindex\.

### Main comment

## 🛑 Slop Sheriff: changes needed

1 finding requires changes.

Allow crawlers to read noindex on public aliases, or redirect those aliases to the canonical host\.

