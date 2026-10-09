// Rose's Flashcard Gate
// Counts every attempt you start (on any level) and writes "<process id> <attempts>" to
// %LOCALAPPDATA%\RosesAnnotationsGD\attempts.txt, which Rose's Annotations watches to know
// when a flashcard break is due. It doesn't change anything in the game.
#include <Geode/Geode.hpp>
#include <Geode/modify/PlayLayer.hpp>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <process.h>

using namespace geode::prelude;

namespace {
    unsigned long long g_attempts = 0;

    std::filesystem::path outFile() {
        char* base = nullptr;
        size_t len = 0;
        if (_dupenv_s(&base, &len, "LOCALAPPDATA") == 0 && base) {
            std::filesystem::path p = std::filesystem::path(base) / "RosesAnnotationsGD" / "attempts.txt";
            std::free(base);
            return p;
        }
        return Mod::get()->getSaveDir() / "attempts.txt";
    }

    void report() {
        auto const file = outFile();
        std::error_code ec;
        std::filesystem::create_directories(file.parent_path(), ec);
        auto tmp = file;
        tmp += ".tmp";
        {
            std::ofstream out(tmp, std::ios::trunc);
            if (!out) return;
            out << _getpid() << ' ' << g_attempts;
        }
        std::filesystem::rename(tmp, file, ec);
        if (ec) {
            std::ofstream out(file, std::ios::trunc);
            out << _getpid() << ' ' << g_attempts;
        }
    }
}

// PlayLayer::resetLevel runs at the start of every attempt (including the first one when a level opens).
class $modify(RoseGatePlayLayer, PlayLayer) {
    void resetLevel() {
        PlayLayer::resetLevel();
        ++g_attempts;
        report();
    }
};

$on_mod(Loaded) {
    report();
}
