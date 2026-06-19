import argparse
import sys


def run_desktop() -> None:
    import pygame
    from src.renderer import Renderer

    pygame.mixer.pre_init(44100, -16, 2, 1024)   # must be before pygame.init()
    pygame.init()
    screen = pygame.display.set_mode((1280, 720), pygame.RESIZABLE)
    pygame.display.set_caption("osu! Replay Viewer")

    renderer = Renderer(screen)
    clock    = pygame.time.Clock()

    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()

            elif event.type == pygame.DROPFILE:
                renderer.handle_drop(event.file)

            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    if renderer.show_help:
                        renderer.toggle_help()
                    else:
                        pygame.quit()
                        sys.exit()
                elif event.key == pygame.K_SPACE:
                    renderer.toggle_pause()
                elif event.key == pygame.K_r:
                    renderer.restart()
                elif event.key == pygame.K_s:
                    renderer.skip_intro()
                elif event.key == pygame.K_TAB:
                    renderer.toggle_mode()
                elif event.key == pygame.K_h:
                    renderer.toggle_help()
                elif event.key == pygame.K_o:
                    renderer.open_file_dialog()
                elif event.key == pygame.K_c:
                    renderer.reset()
                elif event.key == pygame.K_LEFT:
                    renderer.seek(-5000)
                elif event.key == pygame.K_RIGHT:
                    renderer.seek(5000)
                elif event.key in (pygame.K_MINUS, pygame.K_KP_MINUS):
                    renderer.change_speed(-1)
                elif event.key in (pygame.K_EQUALS, pygame.K_PLUS, pygame.K_KP_PLUS):
                    renderer.change_speed(+1)
                elif event.key == pygame.K_LEFTBRACKET:
                    renderer.adjust_music_vol(-0.1)
                elif event.key == pygame.K_RIGHTBRACKET:
                    renderer.adjust_music_vol(+0.1)
                elif event.key == pygame.K_COMMA:
                    renderer.adjust_sfx_vol(-0.1)
                elif event.key == pygame.K_PERIOD:
                    renderer.adjust_sfx_vol(+0.1)

            elif event.type == pygame.MOUSEBUTTONDOWN:
                renderer.handle_mouse_down(event.pos, event.button)
            elif event.type == pygame.MOUSEBUTTONUP:
                renderer.handle_mouse_up()
            elif event.type == pygame.MOUSEMOTION:
                renderer.handle_mouse_motion(event.pos)
            elif event.type == pygame.MOUSEWHEEL:
                renderer.handle_scroll(pygame.mouse.get_pos(), event.y)

            elif event.type == pygame.VIDEORESIZE:
                screen = pygame.display.set_mode(event.size, pygame.RESIZABLE)
                renderer.screen = screen

        renderer.update()
        renderer.draw()
        pygame.display.flip()
        clock.tick(60)


def main() -> None:
    parser = argparse.ArgumentParser(description="osu! Replay Viewer")
    parser.add_argument("--web", action="store_true",
                        help="run the browser version (local web server)")
    parser.add_argument("--port", type=int, default=7270,
                        help="port for --web mode (default 7270)")
    parser.add_argument("--no-browser", action="store_true",
                        help="don't open the browser automatically in --web mode")
    parser.add_argument("--lan", action="store_true",
                        help="make --web mode reachable from other devices "
                             "on the same network (binds to all interfaces)")
    parser.add_argument("--host", default=None,
                        help="host/interface to bind in --web mode "
                             "(default 127.0.0.1; --lan implies 0.0.0.0)")
    args = parser.parse_args()

    if args.web:
        from web.server import run_server
        host = args.host or ("0.0.0.0" if args.lan else "127.0.0.1")
        run_server(port=args.port, open_browser=not args.no_browser,
                   host=host)
    else:
        run_desktop()


if __name__ == "__main__":
    main()
