"""Validate the ZIP container before EbookLib loads it; extract text, never HTML."""

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import posixpath
import re
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile

from bs4 import BeautifulSoup, Comment, NavigableString, Tag
from defusedxml import ElementTree as XML
from ebooklib import epub

from app.config import Settings

OPF = "{http://www.idpf.org/2007/opf}"
ENC = "{http://www.w3.org/2001/04/xmlenc#}"
FONT_ALGORITHMS = {
    "http://www.idpf.org/2008/embedding",
    "http://ns.adobe.com/pdf/enc#RC",
}
FONT_TYPES = {
    "application/vnd.ms-opentype", "application/font-sfnt",
    "application/font-woff", "application/x-font-ttf", "application/x-font-opentype",
    "font/otf", "font/ttf", "font/woff", "font/woff2", "font/sfnt",
}


class InvalidEpub(ValueError):
    pass


class EpubLimitExceeded(InvalidEpub):
    pass


@dataclass
class ParsedBlock:
    kind: str
    heading_level: int | None
    text: str


@dataclass
class ParsedSection:
    spine_position: int
    source_href: str
    title: str
    blocks: list[ParsedBlock]


def resource_path(base: str, href: str) -> str:
    parts = urlsplit(href)
    path = unquote(parts.path)
    if parts.scheme or parts.netloc or path.startswith("/") or "\\" in path:
        raise InvalidEpub("EPUB resources must use local archive paths.")
    result = posixpath.normpath(posixpath.join(base, path))
    if result == ".." or result.startswith("../"):
        raise InvalidEpub("EPUB contains an unsafe resource path.")
    return result


def validate_archive(path: Path, settings: Settings) -> None:
    with ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > settings.max_archive_entries:
            raise EpubLimitExceeded("EPUB has too many archive entries.")
        names = [entry.filename for entry in entries]
        if len(set(names)) != len(names):
            raise InvalidEpub("EPUB contains duplicate archive paths.")
        total = 0
        for entry in entries:
            name = entry.filename
            if name.startswith("/") or "\\" in name or ".." in PurePosixPath(name).parts:
                raise InvalidEpub("EPUB contains an unsafe archive path.")
            if entry.flag_bits & 1:
                raise InvalidEpub("Encrypted ZIP entries are not supported. Use an unencrypted EPUB.")
            if entry.file_size > settings.max_archive_entry_bytes:
                raise EpubLimitExceeded("An EPUB archive entry exceeds the expanded size limit.")
            total += entry.file_size
        if total > settings.max_archive_bytes:
            raise EpubLimitExceeded("EPUB exceeds the total expanded archive size limit.")

        # Verify actual expanded bytes and CRCs, without extracting anything to disk.
        actual_total = 0
        for entry in entries:
            actual_entry = 0
            with archive.open(entry) as source:
                while chunk := source.read(64 * 1024):
                    actual_entry += len(chunk)
                    actual_total += len(chunk)
                    if (actual_entry > settings.max_archive_entry_bytes
                            or actual_total > settings.max_archive_bytes):
                        raise EpubLimitExceeded("EPUB exceeds the expanded archive size limit.")

        if archive.read("mimetype").strip() != b"application/epub+zip":
            raise InvalidEpub("The file is not an EPUB container (invalid mimetype).")
        container = XML.fromstring(archive.read("META-INF/container.xml"))
        roots = container.findall(".//{*}rootfile")
        packages = [root.get("full-path", "") for root in roots
                    if root.get("media-type") == "application/oebps-package+xml"]
        if len(packages) != 1:
            raise InvalidEpub("EPUB must contain one package document; multiple renditions are unsupported.")
        package_path = resource_path("", packages[0])
        package = XML.fromstring(archive.read(package_path))
        manifest = package.find(f"{OPF}manifest")
        spine = package.find(f"{OPF}spine")
        if manifest is None or spine is None or not len(spine):
            raise InvalidEpub("EPUB is missing its manifest or reading spine.")
        by_id: dict[str, str] = {}
        media_types: dict[str, str] = {}
        for item in manifest:
            item_id = item.get("id", "")
            if not item_id or item_id in by_id:
                raise InvalidEpub("EPUB manifest IDs are missing or duplicated.")
            href = resource_path(posixpath.dirname(package_path), item.get("href", ""))
            by_id[item_id] = href
            media_types[href] = item.get("media-type", "")
        for ref in spine:
            href = by_id.get(ref.get("idref", ""))
            if href is None or href not in names:
                raise InvalidEpub("EPUB spine references a missing document.")
            if media_types[href] not in {"application/xhtml+xml", "text/html"}:
                raise InvalidEpub("This EPUB uses an unsupported non-HTML spine document.")

        if "META-INF/encryption.xml" in names:
            encryption = XML.fromstring(archive.read("META-INF/encryption.xml"))
            for encrypted in encryption.iter(f"{ENC}EncryptedData"):
                method = encrypted.find(f"{ENC}EncryptionMethod")
                reference = encrypted.find(f"{ENC}CipherData/{ENC}CipherReference")
                algorithm = method.get("Algorithm") if method is not None else None
                target = resource_path("", reference.get("URI", "")) if reference is not None else ""
                if (algorithm not in FONT_ALGORITHMS or media_types.get(target) not in FONT_TYPES
                        or target not in names):
                    raise InvalidEpub("Encrypted EPUB content is unsupported. Use an unencrypted EPUB; font obfuscation alone is allowed.")


def extract_blocks(content: bytes) -> tuple[str, list[ParsedBlock]]:
    soup = BeautifulSoup(content, "html.parser")
    document_title = soup.title.get_text(strip=True) if soup.title else ""
    for element in soup.find_all(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "noscript", "head"]):
        element.decompose()
    body = soup.body or soup
    blocks: list[ParsedBlock] = []
    buffer: list[str] = []
    boundaries = {"p", "div", "section", "article", "blockquote", "li", "ul", "ol", "pre", "table", "tr", "figure", "figcaption", "hr", *[f"h{i}" for i in range(1, 7)]}

    def flush(kind: str = "paragraph", level: int | None = None) -> None:
        # Inline elements add no invented spaces: "hel<em>lo</em>" stays "hello".
        value = re.sub(r"[\t\r\f\v ]+", " ", "".join(buffer))
        value = re.sub(r" *\n *", "\n", value).strip()
        buffer.clear()
        if value:
            blocks.append(ParsedBlock(kind, level, value))

    def walk(node, kind: str = "paragraph", level: int | None = None) -> None:
        if isinstance(node, Comment):
            return
        if isinstance(node, NavigableString):
            buffer.append(re.sub(r"\s+", " ", str(node)))
        elif isinstance(node, Tag):
            if node.name == "br":
                buffer.append("\n")
                return
            boundary = node.name in boundaries
            if boundary:
                flush(kind, level)
            child_level = int(node.name[1]) if re.fullmatch(r"h[1-6]", node.name or "") else None
            child_kind = "heading" if child_level else "paragraph"
            for child in node.children:
                walk(child, child_kind if boundary else kind, child_level if boundary else level)
            if boundary:
                flush(child_kind, child_level)
            elif node.name in {"td", "th"}:
                buffer.append(" ")

    walk(body)
    flush()
    return document_title, blocks


def parse_epub(path: Path, settings: Settings) -> tuple[str, str, list[ParsedSection]]:
    try:
        validate_archive(path, settings)
        book = epub.read_epub(str(path), options={"ignore_ncx": True})

        def metadata(name: str, fallback: str) -> str:
            values = [str(value).strip() for value, _ in book.get_metadata("DC", name)
                      if value and str(value).strip()]
            return "; ".join(values) if values else fallback

        sections = []
        for spine_position, (item_id, _linear) in enumerate(book.spine):
            item = book.get_item_with_id(item_id)
            if not isinstance(item, epub.EpubHtml):
                raise InvalidEpub("EPUB spine contains an unsupported document.")
            # The original loaded bytes avoid EbookLib HTML reserialization.
            document_title, blocks = extract_blocks(item.content)
            if not blocks:
                continue
            heading = next((block.text for block in blocks if block.kind == "heading"), "")
            sections.append(ParsedSection(
                spine_position, item.file_name,
                heading or document_title or f"Section {len(sections) + 1}", blocks,
            ))
        if not sections:
            raise InvalidEpub("EPUB contains no readable text in its spine.")
        return metadata("title", "Untitled book"), metadata("creator", "Unknown author"), sections
    except InvalidEpub:
        raise
    except Exception as exc:
        raise InvalidEpub("Malformed or unsupported EPUB. Check that it is a valid, unencrypted EPUB file.") from exc
