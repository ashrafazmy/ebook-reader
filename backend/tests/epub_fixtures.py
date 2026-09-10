"""Original synthetic EPUBs for tests and manual checks; no downloaded book text."""

from io import BytesIO
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile


def make_epub(*, metadata: bool = True, encryption: str | None = None,
              body: str | None = None, missing_spine: bool = False,
              extra: dict[str, bytes] | None = None) -> bytes:
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip", compress_type=ZIP_STORED)
        archive.writestr("META-INF/container.xml", '''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>''')
        metadata_xml = '<dc:title>The Small Journey</dc:title><dc:creator>Reader Test Author</dc:creator>' if metadata else ''
        first_id = 'missing' if missing_spine else 'first'
        archive.writestr("OEBPS/book.opf", f'''<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">synthetic-journey</dc:identifier><dc:language>en</dc:language>{metadata_xml}
</metadata><manifest>
<item id="second" href="a-second.xhtml" media-type="application/xhtml+xml"/>
<item id="first" href="z-first.xhtml" media-type="application/xhtml+xml"/>
<item id="font" href="font.otf" media-type="font/otf"/>
</manifest><spine><itemref idref="{first_id}"/><itemref idref="second"/></spine></package>''')
        first_body = body if body is not None else '<h1>The beginning</h1><p>A small boat left the shore.</p><p>The water was <em>quiet</em>.</p>'
        for filename, text in [("z-first.xhtml", first_body), ("a-second.xhtml", '<h2>Across the water</h2><p>The boat reached a new shore.</p>')]:
            archive.writestr(f"OEBPS/{filename}", f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Document title</title></head><body>{text}</body></html>''')
        archive.writestr("OEBPS/font.otf", b"synthetic-font-not-rendered")
        if encryption:
            archive.writestr("META-INF/encryption.xml", encryption)
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return output.getvalue()


def encryption_xml(algorithm: str, target: str) -> str:
    return f'''<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
 xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData>
 <enc:EncryptionMethod Algorithm="{algorithm}"/>
 <enc:CipherData><enc:CipherReference URI="{target}"/></enc:CipherData>
 </enc:EncryptedData></encryption>'''


if __name__ == "__main__":
    import argparse
    from pathlib import Path

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(make_epub())
    print(f"Created synthetic EPUB: {args.output}")
