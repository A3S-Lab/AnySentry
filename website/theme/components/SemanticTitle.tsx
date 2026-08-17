type SemanticTitleProps = {
  id?: string;
  lines: readonly string[];
};

/** Keeps editorial line breaks stable without embedding layout markup in copy. */
export function SemanticTitle({ id, lines }: SemanticTitleProps) {
  return (
    <h2 className="as-semantic-title" id={id}>
      {lines.map((line, index) => (
        <span key={line}>
          {line}
          {index < lines.length - 1 ? ' ' : null}
        </span>
      ))}
    </h2>
  );
}
