import { createElement, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type BookDetail, type SectionDetail, type TextBlock } from './api';
import NarrationPanel from './NarrationPanel';
import ChapterAudio from './ChapterAudio';

export default function Reader({ bookId }: { bookId: string }) {
  const [book, setBook] = useState<BookDetail | null>(null);
  const [section, setSection] = useState<SectionDetail | null>(null);
  const [index, setIndex] = useState(0);
  const [fontSize, setFontSize] = useState(20);
  const [bookError, setBookError] = useState('');
  const [sectionError, setSectionError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [chapterStatus, setChapterStatus] = useState('generation and saved versions');
  const [selected, setSelected] = useState<TextBlock | null>(null);
  const article = useRef<HTMLElement>(null);
  const narrationDetails = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBookError('');
    api<BookDetail>(`/books/${encodeURIComponent(bookId)}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setBook(result); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setBookError(errorMessage(error)); });
    return () => controller.abort();
  }, [bookId, attempt]);

  const sectionId = book?.sections[index]?.id;
  useEffect(() => {
    if (!sectionId) return;
    const controller = new AbortController();
    setSection(null);
    setSelected(null);
    setSectionError('');
    api<SectionDetail>(`/books/${encodeURIComponent(bookId)}/sections/${sectionId}`, { signal: controller.signal })
      .then((content) => { if (!controller.signal.aborted) setSection(content); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setSectionError(errorMessage(error)); });
    return () => controller.abort();
  }, [bookId, sectionId, attempt]);

  function navigate(position: number) {
    if (position === index) return;
    setSection(null);
    setSectionError('');
    setIndex(position);
    setSelected(null);
    article.current?.focus();
    article.current?.scrollIntoView({ block: 'start' });
  }

  return (
    <>
      <a className="back-link" href="#">← Back to bookshelf</a>
      {bookError ? <div role="alert" className="error"><p>{bookError}</p><button onClick={() => setAttempt((value) => value + 1)}>Retry book</button></div>
        : !book ? <p role="status">Opening book…</p> : <>
          <h1 className="reader-title">{book.title}</h1><p className="author">{book.author}</p>
          <div className="reader-controls">
            <label>Section
              <select value={index} onChange={(event) => navigate(Number(event.target.value))}>
                {book.sections.map((item, position) => <option key={item.id} value={position}>{position + 1}. {item.title}</option>)}
              </select>
            </label>
            <label className="font-control">Font size: {fontSize}px
              <input type="range" min="16" max="32" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} />
            </label>
          </div>
          <nav className="section-navigation" aria-label="Section navigation">
            <button disabled={index === 0} onClick={() => navigate(index - 1)}>← Previous</button>
            <span>{index + 1} / {book.sections.length}</span>
            <button disabled={index === book.sections.length - 1} onClick={() => navigate(index + 1)}>Next →</button>
          </nav>
          <details className="generation-details"><summary>Chapter audio · {chapterStatus}</summary>
          <ChapterAudio onStatus={setChapterStatus} book={book} sectionId={sectionId!} navigate={(id) => {
            const position = book.sections.findIndex((item) => item.id === id);
            if (position >= 0) navigate(position);
          }} />
          </details>
          <details ref={narrationDetails} className="generation-details"><summary>Paragraph narration</summary>
          <NarrationPanel key={sectionId} paragraph={section?.blocks.some((block) => block.id === selected?.id) ? selected : null} />
          </details>
          <article ref={article} tabIndex={-1} className="reading-content" style={{ fontSize }} aria-label={book.sections[index]?.title} aria-busy={!section && !sectionError}>
            {sectionError ? <div role="alert" className="error"><p>{sectionError}</p><button onClick={() => setAttempt((value) => value + 1)}>Retry section</button></div>
              : !section ? <p role="status">Loading section…</p> : section.blocks.map((block) =>
                // Text children are escaped by React. No EPUB HTML is inserted.
                block.kind === 'heading' ? createElement(`h${Math.min(6, Math.max(1, block.heading_level ?? 2))}`,
                  { key: block.id, id: `block-${block.id}`, 'data-block-id': block.id }, block.text)
                  : <div key={block.id} className={`paragraph ${selected?.id === block.id ? 'selected' : ''}`}>
                      <p id={`block-${block.id}`} data-block-id={block.id}>{block.text}</p>
                      <button className="narrate-paragraph" aria-pressed={selected?.id === block.id} onClick={() => { setSelected(block); if (narrationDetails.current) { narrationDetails.current.open = true; narrationDetails.current.querySelector('summary')?.focus(); narrationDetails.current.scrollIntoView({ block: 'start' }); } }}>Narrate this paragraph</button>
                    </div>,
              )}
          </article>
          <nav className="section-navigation" aria-label="Continue reading">
            <button disabled={index === 0} onClick={() => navigate(index - 1)}>← Previous section</button>
            <button disabled={index === book.sections.length - 1} onClick={() => navigate(index + 1)}>Next section →</button>
          </nav>
        </>}
    </>
  );
}
