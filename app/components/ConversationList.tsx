import React from 'react';

type Conversation = {
  id: string;
  created_time: string;
  status: string;
  channel_id: string;
};

interface ConversationListProps {
  conversations: Conversation[];
  onConversationClick: (id: string) => void;
  selectedId?: string;
}

export function ConversationList({ conversations, onConversationClick, selectedId }: ConversationListProps) {
  if (!conversations.length) {
    return <div className="text-zinc-500 px-2 py-8">No conversations found.</div>;
  }
  return (
    <div className="grid gap-2 mt-6">
      {conversations.map((conv) => (
        <button
          key={conv.id}
          onClick={() => onConversationClick(conv.id)}
          className={`flex flex-col sm:flex-row gap-1 sm:gap-4 p-3 rounded-lg border transition bg-white dark:bg-zinc-900 hover:shadow-md cursor-pointer text-left ${selectedId === conv.id ? 'border-blue-400 ring-2 ring-blue-300' : 'border-zinc-200 dark:border-zinc-800'}`}
        >
          <span className="font-mono text-sm text-black dark:text-zinc-50">
            <b>ID:</b> {conv.id}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-300">
            <b>Created:</b> {new Date(conv.created_time).toLocaleString()}
          </span>
          <span className="text-xs">
            <b>Status:</b> <span className="capitalize">{conv.status}</span>
          </span>
          <span className="text-xs">
            <b>Channel:</b> {conv.channel_id}
          </span>
        </button>
      ))}
    </div>
  );
}
