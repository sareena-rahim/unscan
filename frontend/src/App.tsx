import { useEffect, useRef, useState, DragEvent, ChangeEvent } from "react";

const rawApi = import.meta.env.VITE_API_URL || "http://localhost:8000";
const API = (/^https?:\/\//.test(rawApi) ? rawApi : `https://${rawApi}`).replace(/\/+$/, "");

type Status = "idle" | "uploading" | "queued" | "processing" | "done" | "error";

type JobUpdate = { status: string; page: number; total: number; error: string | null };

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState({ page: 0, total: 0 });
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("");
  const cancelled = useRef(false);
  const events = useRef<EventSource | null>(null);

  const busy = status === "uploading" || status === "queued" || status === "processing";
  const percent = progress.total ? Math.round((progress.page / progress.total) * 100) : 0;

  // Close the progress stream if the component unmounts
  useEffect(() => {
    return () => {
      cancelled.current = true;
      events.current?.close();
    };
  }, []);

  function triggerDownload(url: string, name: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function readError(res: Response, fallback: string) {
    const data = await res.json().catch(() => null);
    let host = "";
    try {
      host = new URL(res.url).host;
    } catch {}
    return data?.detail ?? `${fallback} (HTTP ${res.status} from ${host})`;
  }

  // One open connection; the server pushes an update only when progress changes
  function waitForJob(jobId: string, onUpdate: (job: JobUpdate) => void) {
    return new Promise<void>((resolve, reject) => {
      const es = new EventSource(`${API}/api/jobs/${jobId}/events`);
      events.current = es;

      es.onmessage = (ev) => {
        const job: JobUpdate = JSON.parse(ev.data);
        onUpdate(job);
        if (job.status === "done") {
          es.close();
          resolve();
        } else if (job.status === "error") {
          es.close();
          reject(new Error(job.error ?? "Conversion failed"));
        }
      };

      es.onerror = () => {
        // CONNECTING means the browser is retrying by itself; CLOSED means it gave up
        if (es.readyState === EventSource.CLOSED) {
          reject(new Error("Lost track of the conversion. The server may have restarted."));
        }
      };
    });
  }

  async function convert() {
    if (!file) return;
    cancelled.current = false;
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    setError("");
    setProgress({ page: 0, total: 0 });
    setStatus("uploading");

    try {
      // 1. Upload and start the job
      const body = new FormData();
      body.append("file", file);
      const start = await fetch(`${API}/api/jobs`, { method: "POST", body });
      if (!start.ok) throw new Error(await readError(start, "Could not start conversion"));
      const { job_id, total } = await start.json();
      setProgress({ page: 0, total });
      setStatus("queued");

      // 2. Follow progress until done
      await waitForJob(job_id, (job) => {
        setProgress({ page: job.page, total: job.total });
        if (job.status === "queued") setStatus("queued");
        if (job.status === "processing") setStatus("processing");
      });
      if (cancelled.current) return;

      // 3. Download the finished PDF
      const result = await fetch(`${API}/api/jobs/${job_id}/result`);
      if (!result.ok) throw new Error(await readError(result, "Could not download the result"));
      const blob = await result.blob();
      const url = URL.createObjectURL(blob);
      const name = file.name.replace(/\.pdf$/i, "") + "_searchable.pdf";
      setDownloadUrl(url);
      setDownloadName(name);
      triggerDownload(url, name);
      setStatus("done");
    } catch (e) {
      events.current?.close();
      setError(
        e instanceof TypeError
          ? "Can't reach the server. It may be waking up, so wait a minute and try again."
          : e instanceof Error
          ? e.message
          : "Something went wrong"
      );
      setStatus("error");
    }
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (!busy) setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const selectFile = (f: File) => {
    setFile(f);
    setError("");
    setStatus("idle");
    setProgress({ page: 0, total: 0 });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (busy) return;
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile && droppedFile.type === "application/pdf") {
      selectFile(droppedFile);
    } else if (droppedFile) {
      setError("Please select a valid PDF file.");
      setStatus("error");
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    if (selected) selectFile(selected);
    e.target.value = ""; // allow re-selecting the same file
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const buttonLabel =
    status === "uploading"
      ? "Uploading..."
      : status === "queued"
      ? "Waiting in queue..."
      : status === "processing"
      ? "Converting document..."
      : "Convert & Download";

  return (
    <div style={styles.container}>
      {/* keyframes for the spinner (inline styles can't define these) */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={styles.card}>
        {/* Header */}
        <header style={styles.header}>
          <div style={styles.badge}>PDF OCR TOOL</div>
          <h1 style={styles.title}>Unscan</h1>
          <p style={styles.subtitle}>
            Upload scanned PDFs and convert them into searchable, selectable text documents.
          </p>
        </header>

        {/* Dropzone Container */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            ...styles.dropzone,
            borderColor: isDragging ? "#059669" : file ? "#10b981" : "#e5e7eb",
            backgroundColor: isDragging ? "#ecfdf5" : file ? "#f0fdf4" : "#f9fafb",
          }}
        >
          <input
            type="file"
            accept="application/pdf"
            id="pdf-input"
            onChange={handleFileChange}
            disabled={busy}
            style={styles.hiddenInput}
          />

          {!file ? (
            <label htmlFor="pdf-input" style={styles.dropzoneContent}>
              <div style={styles.iconCircle}>
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#059669"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <p style={styles.dropText}>
                <span style={styles.highlightText}>Click to upload</span> or drag & drop
              </p>
              <p style={styles.subDropText}>PDF documents up to 50MB</p>
            </label>
          ) : (
            <div style={styles.fileSelectedInfo}>
              <div style={styles.fileHeader}>
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#059669"
                  strokeWidth="2"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={styles.fileName}>{file.name}</p>
                  <p style={styles.fileSize}>{formatSize(file.size)}</p>
                </div>
                {!busy && (
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      setStatus("idle");
                      setProgress({ page: 0, total: 0 });
                    }}
                    style={styles.removeBtn}
                    title="Remove file"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Action Button */}
        <button
          onClick={convert}
          disabled={!file || busy}
          style={{
            ...styles.button,
            opacity: !file || busy ? 0.5 : 1,
            cursor: !file || busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? (
            <span style={styles.loadingFlex}>
              <span style={styles.spinner} />
              {buttonLabel}
            </span>
          ) : (
            buttonLabel
          )}
        </button>

        {/* Progress */}
        {(status === "queued" || status === "processing") && (
          <div style={styles.progressBox}>
            <div style={styles.progressTop}>
              <span style={styles.progressLabel}>
                {status === "queued"
                  ? "Waiting for your turn..."
                  : `${progress.page} of ${progress.total} pages scanned`}
              </span>
              <span style={styles.progressPercent}>{status === "queued" ? "" : `${percent}%`}</span>
            </div>
            <div style={styles.progressTrack}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${status === "queued" ? 0 : percent}%`,
                }}
              />
            </div>
            <p style={styles.progressHint}>Large files can take a few minutes. Keep this tab open.</p>
          </div>
        )}

        {/* Success */}
        {status === "done" && downloadUrl && (
          <div style={styles.successBox}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#047857"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span style={{ flex: 1 }}>
              Done! {progress.total} pages converted.{" "}
              <button
                type="button"
                onClick={() => triggerDownload(downloadUrl, downloadName)}
                style={styles.linkBtn}
              >
                Download again
              </button>
            </span>
          </div>
        )}

        {/* Error Notification */}
        {status === "error" && (
          <div style={styles.errorBox}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#dc2626"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#f8fafc",
    color: "#0f172a",
    fontFamily:
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  },
  card: {
    width: "100%",
    maxWidth: "460px",
    backgroundColor: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "16px",
    padding: "36px",
    boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01)",
  },
  header: {
    marginBottom: "28px",
    textAlign: "left",
  },
  badge: {
    display: "inline-block",
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.08em",
    color: "#047857",
    backgroundColor: "#d1fae5",
    padding: "4px 10px",
    borderRadius: "20px",
    marginBottom: "12px",
  },
  title: {
    fontSize: "28px",
    fontWeight: 700,
    margin: "0 0 8px 0",
    letterSpacing: "-0.02em",
    color: "#0f172a",
  },
  subtitle: {
    fontSize: "14px",
    color: "#64748b",
    margin: 0,
    lineHeight: "1.5",
  },
  dropzone: {
    border: "2px dashed",
    borderRadius: "12px",
    padding: "28px 20px",
    textAlign: "center",
    transition: "all 0.2s ease-in-out",
    marginBottom: "24px",
    cursor: "pointer",
  },
  hiddenInput: {
    display: "none",
  },
  dropzoneContent: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    cursor: "pointer",
  },
  iconCircle: {
    width: "48px",
    height: "48px",
    borderRadius: "50%",
    backgroundColor: "#d1fae5",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "12px",
  },
  dropText: {
    fontSize: "14px",
    color: "#334155",
    margin: "0 0 4px 0",
  },
  highlightText: {
    color: "#059669",
    fontWeight: 600,
  },
  subDropText: {
    fontSize: "12px",
    color: "#94a3b8",
    margin: 0,
  },
  fileSelectedInfo: {
    textAlign: "left",
  },
  fileHeader: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  fileName: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#1e293b",
    margin: "0 0 2px 0",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  fileSize: {
    fontSize: "12px",
    color: "#64748b",
    margin: 0,
  },
  removeBtn: {
    background: "transparent",
    border: "none",
    color: "#94a3b8",
    fontSize: "16px",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "4px",
  },
  button: {
    width: "100%",
    padding: "14px",
    borderRadius: "10px",
    backgroundColor: "#059669",
    color: "#ffffff",
    fontWeight: 600,
    fontSize: "15px",
    border: "none",
    transition: "all 0.2s ease",
    boxShadow: "0 4px 12px rgba(5, 150, 105, 0.2)",
  },
  loadingFlex: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
  },
  spinner: {
    width: "16px",
    height: "16px",
    border: "2px solid rgba(255, 255, 255, 0.3)",
    borderTopColor: "#ffffff",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  progressBox: {
    marginTop: "16px",
    padding: "14px 16px",
    borderRadius: "10px",
    backgroundColor: "#f8fafc",
    border: "1px solid #e2e8f0",
  },
  progressTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "8px",
  },
  progressLabel: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#334155",
  },
  progressPercent: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#059669",
  },
  progressTrack: {
    height: "8px",
    borderRadius: "999px",
    backgroundColor: "#e2e8f0",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: "999px",
    backgroundColor: "#10b981",
    transition: "width 0.4s ease",
  },
  progressHint: {
    fontSize: "12px",
    color: "#94a3b8",
    margin: "10px 0 0 0",
  },
  successBox: {
    marginTop: "16px",
    padding: "12px 16px",
    borderRadius: "8px",
    backgroundColor: "#ecfdf5",
    border: "1px solid #a7f3d0",
    color: "#065f46",
    fontSize: "13px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  linkBtn: {
    background: "transparent",
    border: "none",
    padding: 0,
    color: "#047857",
    fontWeight: 600,
    fontSize: "13px",
    textDecoration: "underline",
    cursor: "pointer",
  },
  errorBox: {
    marginTop: "16px",
    padding: "12px 16px",
    borderRadius: "8px",
    backgroundColor: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#991b1b",
    fontSize: "13px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
};