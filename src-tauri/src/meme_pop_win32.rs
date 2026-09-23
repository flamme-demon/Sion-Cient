//! Fenêtre d'un meme sous Windows : une fenêtre « layered », au premier plan,
//! traversée par les clics — les mêmes styles que l'overlay des curseurs,
//! dont elle reprend la surface GDI.
//!
//! Limite connue : un jeu en plein écran EXCLUSIF passe devant toute fenêtre ;
//! seul le plein écran fenêtré (« borderless »), aujourd'hui le plus courant,
//! laisse le meme apparaître.

use std::sync::OnceLock;

use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{AC_SRC_ALPHA, AC_SRC_OVER, BLENDFUNCTION};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
    RegisterClassExW, ShowWindow, SystemParametersInfoW, TranslateMessage, UpdateLayeredWindow,
    MSG, PM_REMOVE, SPI_GETWORKAREA, SW_SHOWNOACTIVATE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    ULW_ALPHA, WNDCLASSEXW, WNDCLASS_STYLES, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows_core::w;

use crate::cursor_overlay::win32_host::Surface;

pub(super) struct FenetreWin32 {
    hwnd: HWND,
    surface: Surface,
    position: POINT,
}

unsafe extern "system" fn procedure(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, message, wparam, lparam)
}

fn enregistrer_classe() -> Result<(), String> {
    static FAIT: OnceLock<Result<(), String>> = OnceLock::new();
    FAIT.get_or_init(|| {
        let module = unsafe { GetModuleHandleW(None) }.map_err(|e| e.to_string())?;
        let classe = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: WNDCLASS_STYLES::default(),
            lpfnWndProc: Some(procedure),
            hInstance: HINSTANCE(module.0),
            lpszClassName: w!("SION_MEME_POP"),
            ..Default::default()
        };
        if unsafe { RegisterClassExW(&classe) } == 0 {
            Err(windows_core::Error::from_win32().to_string())
        } else {
            Ok(())
        }
    })
    .clone()
}

/// Zone de travail de l'écran principal : l'écran moins la barre des tâches.
fn zone_de_travail() -> RECT {
    let mut zone = RECT::default();
    let lu = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut zone as *mut RECT as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    if lu.is_err() || zone.right <= zone.left || zone.bottom <= zone.top {
        return RECT {
            left: 0,
            top: 0,
            right: 1280,
            bottom: 720,
        };
    }
    zone
}

impl FenetreWin32 {
    pub(super) fn ouvrir(
        largeur: u32,
        hauteur: u32,
        placer: &mut dyn FnMut(u32, u32) -> (i32, i32),
    ) -> Result<Self, String> {
        enregistrer_classe()?;
        let zone = zone_de_travail();
        let (x, y) = placer(
            (zone.right - zone.left) as u32,
            (zone.bottom - zone.top) as u32,
        );
        let position = POINT {
            x: zone.left + x,
            y: zone.top + y,
        };
        let module = unsafe { GetModuleHandleW(None) }.map_err(|e| e.to_string())?;
        // Créée sur le fil du meme : c'est lui qui pompera ses messages.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE
                    | WS_EX_TOOLWINDOW,
                w!("SION_MEME_POP"),
                w!("Sion meme"),
                WS_POPUP,
                position.x,
                position.y,
                largeur as i32,
                hauteur as i32,
                None,
                None,
                HINSTANCE(module.0),
                None,
            )
        }
        .map_err(|e| e.to_string())?;
        let surface = match Surface::new(largeur as i32, hauteur as i32) {
            Ok(s) => s,
            Err(e) => {
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
                return Err(e);
            }
        };
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        Ok(Self {
            hwnd,
            surface,
            position,
        })
    }

    /// `bgra` : le BGRA pré-multiplié qu'attend `UpdateLayeredWindow`.
    pub(super) fn presenter(&mut self, bgra: &[u8]) -> Result<(), String> {
        // Sans pompe, Windows tient la fenêtre pour figée et peut la griser.
        let mut msg = MSG::default();
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        let octets = self.surface.largeur as usize * self.surface.hauteur as usize * 4;
        if bgra.len() != octets {
            return Err("image de taille inattendue".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bgra.as_ptr(), self.surface.pixels, octets);
        }
        let taille = SIZE {
            cx: self.surface.largeur,
            cy: self.surface.hauteur,
        };
        let source = POINT { x: 0, y: 0 };
        let melange = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        unsafe {
            UpdateLayeredWindow(
                self.hwnd,
                None,
                Some(&self.position),
                Some(&taille),
                self.surface.dc,
                Some(&source),
                COLORREF(0),
                Some(&melange),
                ULW_ALPHA,
            )
        }
        .map_err(|e| format!("présentation refusée : {e}"))
    }
}

impl Drop for FenetreWin32 {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}
