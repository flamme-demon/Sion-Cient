import { create } from "zustand";
import {
  initAdminService,
  getServerVersion,
  getLocalUserCount,
  getRoomsList,
  AdminApiError,
} from "../services/adminService";

interface AdminData {
  totalUsers: number | null;
  totalRooms: number | null;
  serverName: string | null;
  serverVersion: string | null;
}

interface AdminState {
  data: AdminData;
  isAdmin: boolean | null;
  isLoading: boolean;
  initialized: boolean;

  fetchAdminData: (homeserverUrl: string, accessToken: string) => Promise<void>;
  startAdminCheck: () => void;
  stopAdminCheck: () => void;
  reset: () => void;
}

const initialData: AdminData = {
  totalUsers: null,
  totalRooms: null,
  serverName: null,
  serverVersion: null,
};

let adminCheckInterval: ReturnType<typeof setInterval> | null = null;
let savedHomeserverUrl = "";
let savedAccessToken = "";

export const useAdminStore = create<AdminState>((set, get) => ({
  data: { ...initialData },
  isAdmin: null,
  isLoading: false,
  initialized: false,

  fetchAdminData: async (homeserverUrl, accessToken) => {
    if (get().isLoading) return;
    set({ isLoading: true });

    savedHomeserverUrl = homeserverUrl;
    savedAccessToken = accessToken;
    initAdminService({ homeserverUrl, accessToken });

    const data: AdminData = { ...initialData };

    // Server version (no auth)
    try {
      const version = await getServerVersion();
      data.serverName = version.name;
      data.serverVersion = version.version;
    } catch (err) {
      console.error("[Admin] getServerVersion failed:", err);
    }

    // Local user count (no auth, needs federation enabled)
    try {
      const users = await getLocalUserCount();
      data.totalUsers = users.count;
    } catch (err) {
      console.error("[Admin] getLocalUserCount failed:", err);
    }

    // Rooms list (admin auth required)
    let isAdmin = true;
    try {
      const rooms = await getRoomsList();
      if (Array.isArray(rooms)) {
        data.totalRooms = rooms.length;
      } else if (rooms && typeof rooms === "object") {
        // Handle wrapped response like { rooms: [...] } or { total: N }
        const obj = rooms as Record<string, unknown>;
        if (Array.isArray(obj.rooms)) {
          data.totalRooms = obj.rooms.length;
        } else if (typeof obj.total === "number") {
          data.totalRooms = obj.total;
        } else if (typeof obj.total_rooms === "number") {
          data.totalRooms = obj.total_rooms;
        }
      }
    } catch (err) {
      console.error("[Admin] getRoomsList failed:", err);
      if (err instanceof AdminApiError && (err.status === 403 || err.status === 401)) {
        isAdmin = false;
      }
    }

    set({ data, isAdmin, isLoading: false, initialized: true });
  },

  startAdminCheck: () => {
    if (adminCheckInterval) return;
    // Vérifie le statut admin toutes les 15s (appel léger à getRoomsList)
    adminCheckInterval = setInterval(async () => {
      if (!savedHomeserverUrl || !savedAccessToken) return;
      const wasAdmin = get().isAdmin;
      try {
        await getRoomsList();
        if (!wasAdmin) {
          // Devenu admin — refresh complet
          set({ isAdmin: true, initialized: false });
          get().fetchAdminData(savedHomeserverUrl, savedAccessToken);
        }
      } catch (err) {
        if (err instanceof AdminApiError && (err.status === 403 || err.status === 401)) {
          if (wasAdmin) {
            // N'est plus admin
            set({ isAdmin: false });
          }
        }
      }
    }, 15000);
  },

  stopAdminCheck: () => {
    if (adminCheckInterval) {
      clearInterval(adminCheckInterval);
      adminCheckInterval = null;
    }
  },

  reset: () => {
    if (adminCheckInterval) {
      clearInterval(adminCheckInterval);
      adminCheckInterval = null;
    }
    set({
      data: { ...initialData },
      isAdmin: null,
      isLoading: false,
      initialized: false,
    });
  },
}));
