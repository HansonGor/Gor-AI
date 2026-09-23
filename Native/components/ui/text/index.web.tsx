import React from 'react';

type ITextProps = React.ComponentProps<'span'> & {
  className?: string;
  size?: string;
  bold?: boolean;
  isTruncated?: boolean;
  underline?: boolean;
  strikeThrough?: boolean;
  sub?: boolean;
  italic?: boolean;
  highlight?: boolean;
  numberOfLines?: number;
};

const Text = React.forwardRef<HTMLSpanElement, ITextProps>(
  function Text({ className = '', size, bold, isTruncated, underline, strikeThrough, sub, italic, highlight, numberOfLines, ...props }, ref) {
    // numberOfLines 是 React Native 专属 prop，web 端转换为 CSS 截断，避免泄漏到 DOM 触发 warning
    const lineClampStyle =
      typeof numberOfLines === 'number' && numberOfLines > 0
        ? { WebkitLineClamp: numberOfLines, display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' }
        : undefined;
    return <span className={className} style={lineClampStyle} {...props} ref={ref} />;
  }
);

Text.displayName = 'Text';

export { Text };
