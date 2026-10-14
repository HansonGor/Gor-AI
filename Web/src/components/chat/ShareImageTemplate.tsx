import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles } from 'lucide-react';
import type { ShareMessage } from '../../share/shareContent';
import { shareCitations } from '../../share/shareContent';
import './ChatShare.less';
import { shareCodeComponents } from './MarkdownCodeBlock';

export default function ShareImageTemplate({ messages }: { messages: ShareMessage[] }) {
  return (
    <article className="gor-share-sheet">
      <div className="gor-share-frame">
        <img
          className="gor-share-landscape"
          src={`${import.meta.env.BASE_URL}images/jiangnan-chat-bg.png`}
          alt="江南夜色"
        />
        <header className="gor-share-brand">
          <span>
            <Sparkles size={29} strokeWidth={1.7} /> Gor
          </span>
          <small>一纸对话 · 万千思绪</small>
        </header>
        <div className="gor-share-body">
          {messages.map((message) => (
            <section className="gor-share-message" key={message.id} data-message-id={message.id}>
              <h2 className="gor-share-label">
                {message.role === 'user' ? '你 · 提问' : 'Gor · 回答'}
              </h2>
              <div className="gor-share-card">
                <ReactMarkdown
                  components={shareCodeComponents}
                  remarkPlugins={
                    message.role === 'assistant'
                      ? [remarkGfm, shareCitations(message.citationNames)]
                      : [remarkGfm]
                  }
                >
                  {message.content}
                </ReactMarkdown>
                {message.images.map((src, index) => (
                  <img key={index} src={src} alt="正文图片" />
                ))}
              </div>
            </section>
          ))}
        </div>
        <footer className="gor-share-footer">
          <span>与 Gor 共赴一程山水</span>
          <span>
            <Sparkles size={25} strokeWidth={1.7} /> Gor
          </span>
        </footer>
      </div>
    </article>
  );
}
