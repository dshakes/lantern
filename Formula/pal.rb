# Homebrew formula for the pal CLI (PAL Runtime). The release workflow pins
# url + sha256 on each tag and syncs this file into dshakes/homebrew-tap:
#
#   brew install dshakes/tap/pal
#
class Pal < Formula
  desc "CLI for PAL Runtime, the production runtime for AI agents"
  homepage "https://github.com/dshakes/lantern"
  url "https://github.com/dshakes/lantern/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "b29234e12cc6df3c25b0e0bf7fe5db39cafe0ec4147a067618efe92fd57299f7"
  license "Apache-2.0"
  head "https://github.com/dshakes/lantern.git", branch: "master"

  depends_on "go" => :build

  def install
    cd "packages/cli" do
      system "go", "build", *std_go_args(output: bin/"pal", ldflags: "-s -w -X main.version=#{version}"), "./cmd/pal"
    end
  end

  test do
    system bin/"pal", "--version"
  end
end
