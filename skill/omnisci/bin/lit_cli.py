#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Literature CLI: real references, no model involved.

OpenAlex and Crossref are plain HTTP, so host mode keeps the engine's hard rule that every citation is a paper
that actually exists. The host writes the queries (it is the brain); this fetches the hits and turns the chosen
ones into a real .bib.

Every hit carries a `doi` and a `url`, so a reference can be opened and checked by a human. A hit whose doi is
null was still returned by a real index, but prefer the ones that can be verified.

  python3 lit_cli.py search --query "Raman spectral library mineral identification" --n 6
  python3 lit_cli.py bib    --task raman --picks picks.json

`picks.json` is a JSON list of hit objects exactly as `search` prints them, keeping only the ones you decided
to cite. A broad query returns off-topic hits; dropping them is your job, not the tool's.
"""
import os, re, sys, json, argparse, urllib.parse, urllib.request, hashlib, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostbridge as hb

MAIL = "mmsci@example.org"
UA = {"User-Agent": "omnisci/1.0 (mailto:%s)" % MAIL}


def _file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _clean(title):
    """Indexed titles carry markup (<i>in vivo</i>, <sub>2</sub>) that would land verbatim in the .bib."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", title or "")).strip()


def _get(url, timeout=20):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}


_OA_SELECT = "id,doi,title,publication_year,authorships,primary_location,biblio"


def _normalise_doi(doi):
    return re.sub(r"^https?://(?:dx\.)?doi\.org/", "", str(doi or "").strip(), flags=re.I).lower()


def _map_oa(w):
    loc = (w.get("primary_location") or {}).get("source") or {}
    bib = w.get("biblio") or {}
    doi = (w.get("doi") or "").replace("https://doi.org/", "") or None
    return {"title": _clean(w["title"]), "year": w.get("publication_year"),
            "authors": [a.get("author", {}).get("display_name", "") for a in (w.get("authorships") or [])[:10]],
            "venue": loc.get("display_name") or "", "volume": bib.get("volume"),
            "pages": bib.get("first_page"), "doi": doi,
            "url": ("https://doi.org/" + doi) if doi else w.get("id"), "source": "openalex"}


def by_doi(doi):
    """Free-text search is not stable across calls: the same query can return a paper one minute and not the
    next. Once you have decided to cite something, pin it by DOI so the bibliography is reproducible."""
    doi = _normalise_doi(doi)
    qs = urllib.parse.urlencode({"mailto": MAIL, "select": _OA_SELECT})
    w = _get("https://api.openalex.org/works/doi:%s?%s" % (doi, qs))
    if w.get("title"):
        return [_map_oa(w)]
    item = (_get("https://api.crossref.org/works/%s" % urllib.parse.quote(doi, safe="")).get("message") or {})
    return [_map_crossref(item)] if item.get("title") else []


def _openalex(query, n):
    qs = urllib.parse.urlencode({"search": query, "per_page": n, "mailto": MAIL, "select": _OA_SELECT})
    return [_map_oa(w) for w in (_get("https://api.openalex.org/works?" + qs).get("results") or []) if w.get("title")]


def _map_crossref(w):
    title = (w.get("title") or [""])[0]
    year = ((w.get("issued") or {}).get("date-parts") or [[None]])[0][0]
    authors = [" ".join(x for x in (a.get("given"), a.get("family")) if x)
               for a in (w.get("author") or [])[:10]]
    doi = _normalise_doi(w.get("DOI")) or None
    return {"title": _clean(title), "year": year, "authors": [a for a in authors if a],
            "venue": (w.get("container-title") or [""])[0], "volume": w.get("volume"),
            "pages": w.get("page"), "doi": doi,
            "url": ("https://doi.org/" + doi) if doi else None, "source": "crossref"}


def _crossref(query, n):
    qs = urllib.parse.urlencode({"query.bibliographic": query, "rows": n, "mailto": MAIL,
                                 "select": "DOI,title,author,container-title,issued,volume,page"})
    return [_map_crossref(w) for w in
            ((_get("https://api.crossref.org/works?" + qs).get("message") or {}).get("items") or [])
            if w.get("title")]


def search(query, n):
    """n is the number of hits you get back, not a per-index quota."""
    hits, seen, out = _openalex(query, n) + _crossref(query, max(2, n // 2)), set(), []
    for h in hits:
        k = (h.get("doi") or (h.get("title") or "").strip().lower()[:90])
        if k and k not in seen:
            seen.add(k)
            out.append(h)
    return out[:n]


def write_bib(td, picks):
    p = hb.engine_module("paper")
    used, entries, keys = set(), [], []
    canonical, seen_dois = [], set()
    if not isinstance(picks, list) or not picks:
        raise SystemExit("picks.json must be a non-empty list of search hits")
    for picked in picks:
        doi = _normalise_doi((picked or {}).get("doi"))
        if not doi:
            raise SystemExit("every cited work must have a DOI so bib can re-verify it")
        if doi in seen_dois:
            continue
        resolved = by_doi(doi)
        if not resolved:
            raise SystemExit("DOI did not resolve through OpenAlex or Crossref: %s" % doi)
        hit = resolved[0]
        hit["doi"] = doi
        canonical.append(hit)
        seen_dois.add(doi)

    for hit in canonical:
        key = p._keygen(hit, used)
        entry = p._bib_entry(key, hit)
        # BibTeX lowercases a title it is not told to protect, which turns MedMNIST into "Medmnist", AI into
        # "Ai" and CT into "ct" in every rendered bibliography. Double braces keep the indexed capitalisation.
        entry = re.sub(r"title=\{(.*)\}", lambda m: "title={{%s}}" % m.group(1), entry, count=1)
        if hit.get("doi"):                                  # keep the identifier in the bib so it stays checkable
            entry = entry.rstrip()[:-1].rstrip() + ",\n  doi={" + hit["doi"] + "}\n}"
        entries.append(entry)
        keys.append({"key": key, "title": hit.get("title"), "year": hit.get("year"), "doi": hit.get("doi")})
    path = os.path.join(hb.host_dir(td), "references.bib")
    open(path, "w").write("\n\n".join(entries) + "\n")
    bib_sha = _file_sha256(path)
    provenance = os.path.join(hb.host_dir(td), "references.provenance.json")
    json.dump({"version": 1, "verified_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "bib_sha256": bib_sha,
               "entries": [{"doi": h["doi"], "title": h["title"], "source": h.get("source"),
                            "url": h.get("url")} for h in canonical]},
              open(provenance, "w"), indent=2, ensure_ascii=False)
    return {"bib": path, "provenance": provenance, "n": len(keys), "keys": keys,
            "bib_sha256": bib_sha, "provenance_sha256": _file_sha256(provenance)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="query OpenAlex + Crossref for real papers")
    s.add_argument("--query", help="free-text query")
    s.add_argument("--doi", help="pin one paper by DOI instead (stable across runs)")
    s.add_argument("--n", type=int, default=6, help="how many hits to return in total")

    b = sub.add_parser("bib", help="turn chosen hits into references.bib")
    b.add_argument("--task", required=True)
    b.add_argument("--picks", required=True, help="JSON file: a list of hit objects as printed by search")

    a = ap.parse_args()
    if a.cmd == "search":
        if not (a.query or a.doi):
            raise SystemExit("give --query or --doi")
        out = by_doi(a.doi) if a.doi else search(a.query, a.n)
    else:
        td = hb.resolve_task(a.task)
        out = write_bib(td, json.load(open(hb.case_path(td, a.picks))))
    print(json.dumps({"case": td, **out} if isinstance(out, dict) else out,
                     indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
