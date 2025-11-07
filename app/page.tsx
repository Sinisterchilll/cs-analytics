"use client";
import React, { useState } from "react";
import { ConversationList } from "./components/ConversationList";
import { MessageList } from "./components/MessageList";
import toast, { Toaster } from "react-hot-toast";

export default function Home() {
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);

  // Phone input: allow only numbers
  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^0-9]/g, "");
    setPhone(value);
  };

  const fetchConversations = async () => {
    setSelectedId(null);
    setMessages([]);
    if (!/^\d{6,15}$/.test(phone)) {
      toast.error("Please enter a valid phone number (6-15 digits)");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/get-conversations?phone=${encodeURIComponent(phone)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "API error");
      }
      setConversations(data.conversations || []);
      if (!data.conversations?.length) {
        toast("No conversations found for user", { icon: "🔍" });
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to fetch conversations");
    } finally {
      setLoading(false);
    }
  };

  const fetchMessages = async (conversationId: string) => {
    setSelectedId(conversationId);
    setMessages([]);
    setMsgLoading(true);
    try {
      const res = await fetch(`/api/get-messages?conversation_id=${encodeURIComponent(conversationId)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "API error");
      }
      setMessages(data.messages || []);
      if (!data.messages?.length) {
        toast("No messages in this conversation", { icon: "💬" });
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to fetch messages");
    } finally {
      setMsgLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen justify-center items-start bg-zinc-50 dark:bg-black">
      <Toaster position="top-right" />
      <main className="w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-lg shadow-lg mt-10 p-6 flex flex-col items-center">
        <h1 className="text-2xl font-bold mb-6 text-black dark:text-zinc-50">Freshchat Conversations</h1>
        <div className="flex w-full flex-col sm:flex-row gap-4 items-center justify-center mb-6">
          <input
            className="flex-1 p-3 border rounded focus:outline-none focus:ring-2 focus:ring-blue-400 bg-zinc-50 dark:bg-zinc-800 text-black dark:text-zinc-50"
            placeholder="Phone number (e.g. 174285396)"
            value={phone}
            onChange={handlePhoneChange}
            maxLength={15}
            inputMode="numeric"
            autoFocus
          />
          <button
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded font-semibold transition min-w-[160px]"
            onClick={fetchConversations}
            disabled={loading}
          >
            {loading ? (
              <span className="flex justify-center items-center gap-2 animate-pulse">
                <svg className="h-5 w-5 text-white animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                Loading...
              </span>
            ) : (
              "Fetch Conversations"
            )}
          </button>
        </div>
        <ConversationList
          conversations={conversations}
          onConversationClick={fetchMessages}
          selectedId={selectedId || undefined}
        />
        {msgLoading && (
          <div className="flex items-center gap-2 mt-5 animate-pulse">
            <svg className="h-5 w-5 text-blue-600 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
            Loading messages...
          </div>
        )}
        {!!messages.length && !msgLoading && (
          <section className="w-full">
            <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">Messages</h2>
            <MessageList messages={messages} />
          </section>
        )}
      </main>
    </div>
  );
}
