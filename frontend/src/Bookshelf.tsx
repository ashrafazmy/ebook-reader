import { useEffect, useState, type ChangeEvent } from 'react';
import { api, errorMessage, type BookSummary } from './api';

export default function Bookshelf() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<BookSummary[]>('/books', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setBooks(result); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadError('');
    setNotice('');
    if (!file.name.toLowerCase().endsWith('.epub')) {
      setUploadError('Choose an .epub file.');
      return;
    }
    setUploading(true);
    const data = new FormData();
    data.append('file', file);
    try {
      const book = await api<BookSummary>('/books', { method: 'POST', body: data });
      setNotice(`Added “${book.title}” to your bookshelf.`);
      setAttempt((value) => value + 1);
    } catch (error) {
      setUploadError(errorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <div className="shelf-heading">
        <div><span className="eyebrow">YOUR LOCAL LIBRARY</span><h1>Your bookshelf</h1></div>
        <label className={`upload-button ${uploading ? 'disabled' : ''}`}>
          {uploading ? 'Importing EPUB…' : 'Upload EPUB'}
          <input type="file" accept=".epub,application/epub+zip" disabled={uploading} onChange={upload} aria-label="Upload EPUB" />
        </label>
      </div>
      <p className="intro">Upload an unencrypted EPUB to read or generate chapter audio.</p>
      {uploading && <p role="status">Uploading and preparing your book. Please keep this page open.</p>}
      {notice && <p role="status">{notice}</p>}
      {uploadError && <p role="alert" className="error">{uploadError}</p>}
      {loading ? <p role="status">Loading your bookshelf…</p> : error ? (
        <div className="error" role="alert"><p>{error}</p><button onClick={() => setAttempt((value) => value + 1)}>Retry bookshelf</button></div>
      ) : books.length === 0 ? (
        <section className="empty"><h2>Your next chapter starts here.</h2><p>No books yet. Use Upload EPUB to add a book, then choose a chapter to read or narrate.</p></section>
      ) : (
        <div className="book-grid">
          {books.map((book) => <a className="book-card" key={book.id} href={`#book=${book.id}`}>
            <span className="book-mark" aria-hidden="true">EPUB</span>
            <h2>{book.title}</h2><p>{book.author}</p>
            <span>{book.section_count} {book.section_count === 1 ? 'section' : 'sections'} · Open book →</span>
          </a>)}
        </div>
      )}
    </>
  );
}
